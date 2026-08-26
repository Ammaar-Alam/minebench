import { randomUUID } from "node:crypto";
import { Prisma, type CustomBuildArtifactKind } from "@prisma/client";
import type { GenerateModelRequest, PaletteMode, ProviderApiKeys } from "@/lib/ai/types";
import { sha256Hex } from "@/lib/custom-builds/hash";
import { generateCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { getCustomBuildJobMaxAttempts } from "@/lib/custom-builds/jobs";
import { encryptProviderKey, encryptSecretValue } from "@/lib/custom-builds/secrets";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import { deleteCustomBuildArtifact } from "@/lib/custom-builds/storage";
import { resolveSavedGenerationModel } from "@/lib/generations/model";
import { prisma } from "@/lib/prisma";

const STORAGE_FAILSAFE_BYTES = 1024 * 1024 * 1024;
const SECRET_TTL_MS = 24 * 60 * 60 * 1000;

export class GenerationServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GenerationServiceError";
  }
}

export type CreateSavedGenerationsInput = {
  ownerId: string;
  prompt: string;
  gridSize: 64 | 256 | 512;
  palette: PaletteMode;
  models: GenerateModelRequest[];
  providerKeys: ProviderApiKeys;
  reasoning?: string;
  requestedIpHash?: string | null;
  requestedUserAgentHash?: string | null;
};

const generationSelect = {
  id: true,
  publicId: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  completedAt: true,
  status: true,
  currentStage: true,
  promptText: true,
  gridSize: true,
  palette: true,
  modelKind: true,
  modelProvider: true,
  modelId: true,
  modelDisplayName: true,
  blockCount: true,
  generationTimeMs: true,
  warnings: true,
  buildSha256: true,
  buildByteSize: true,
  buildCompressedByteSize: true,
  storedByteSize: true,
  errorCode: true,
  errorMessage: true,
  errorRetryable: true,
  artifacts: {
    select: {
      kind: true,
      format: true,
      contentType: true,
      byteSize: true,
      storedByteSize: true,
      sha256: true,
    },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.CustomBuildSelect;

type GenerationRow = Prisma.CustomBuildGetPayload<{ select: typeof generationSelect }>;

function serializeGeneration(row: GenerationRow) {
  const artifactKinds = new Set(row.artifacts.map((artifact) => artifact.kind));
  const artifactsAvailable = row.status === "succeeded";
  const viewerKind = artifactKinds.has("viewer_mbf1")
    ? "viewer_mbf1"
    : artifactKinds.has("viewer_mbv4")
      ? "viewer_mbv4"
      : null;
  return {
    id: row.publicId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    status: row.status,
    stage: row.currentStage,
    prompt: row.promptText,
    gridSize: row.gridSize,
    palette: row.palette,
    model: {
      kind: row.modelKind,
      provider: row.modelProvider,
      id: row.modelId,
      label: row.modelDisplayName,
    },
    blockCount: row.blockCount,
    generationTimeMs: row.generationTimeMs,
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((value): value is string => typeof value === "string") : [],
    expandedBytes: row.buildByteSize,
    canonicalStoredBytes: row.buildCompressedByteSize,
    storedBytes: row.storedByteSize,
    sha256: row.buildSha256,
    error: row.errorCode
      ? {
          code: row.errorCode,
          message: row.errorMessage ?? "Generation failed.",
          retryable: row.errorRetryable ?? false,
        }
      : null,
    previewUrl: artifactsAvailable && artifactKinds.has("preview_mbv4")
      ? `/api/generations/${row.publicId}/artifacts/preview`
      : null,
    thumbnailUrl: artifactsAvailable && artifactKinds.has("preview_svg")
      ? `/api/generations/${row.publicId}/artifacts/thumbnail`
      : null,
    viewerUrl: artifactsAvailable && viewerKind
      ? `/api/generations/${row.publicId}/artifacts/viewer`
      : null,
    downloadUrl: artifactsAvailable && artifactKinds.has("build_json")
      ? `/api/generations/${row.publicId}/download`
      : null,
  };
}

export type SavedGenerationPayload = ReturnType<typeof serializeGeneration>;

function dayKey(now: Date): Date {
  return new Date(now.toISOString().slice(0, 10));
}

export async function createSavedGenerations(input: CreateSavedGenerationsInput) {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 800 || input.models.length < 1 || input.models.length > 8) {
    throw new GenerationServiceError("invalid_request", "Check the prompt and model selection.");
  }
  if (new Set(input.models.map((model) => model.id)).size !== input.models.length) {
    throw new GenerationServiceError("invalid_request", "Model selections must be unique.");
  }

  const retained = await prisma.customBuild.aggregate({
    where: {
      ownerId: input.ownerId,
      storedByteSize: { gt: 0 },
    },
    _sum: { storedByteSize: true },
  });
  if ((retained._sum.storedByteSize ?? 0) >= STORAGE_FAILSAFE_BYTES) {
    throw new GenerationServiceError(
      "storage_failsafe",
      "Remove a saved generation before starting another.",
    );
  }

  let resolved;
  try {
    resolved = await Promise.all(
      input.models.map((model) => resolveSavedGenerationModel(model, input.providerKeys)),
    );
  } catch (error) {
    if (error instanceof GenerationServiceError) throw error;
    const message = error instanceof Error ? error.message : "invalid_request";
    throw new GenerationServiceError(
      message === "missing_provider_key" ? "missing_provider_key" : "invalid_model",
      message === "missing_provider_key" ? "Add the provider key required by this model." : "Check the model configuration.",
    );
  }

  const now = new Date();
  const maxAttempts = getCustomBuildJobMaxAttempts();
  const prepared = resolved.map((model) => {
    const id = randomUUID();
    const publicId = generateCustomBuildPublicId();
    const credential = encryptProviderKey(model.credential.value, {
      provider: model.credential.provider,
      binding: id,
    });
    const endpoint = model.customBaseUrl
      ? encryptSecretValue(model.customBaseUrl, id)
      : null;
    return { id, publicId, model, credential, endpoint };
  });

  await prisma.$transaction(async (tx) => {
    for (const item of prepared) {
      await tx.customBuild.create({
        data: {
          id: item.id,
          publicId: item.publicId,
          ownerId: input.ownerId,
          status: "queued",
          currentStage: "queued",
          promptText: prompt,
          promptSha256: sha256Hex(prompt),
          gridSize: input.gridSize,
          palette: input.palette,
          modelKind: item.model.modelKind,
          modelKey: item.model.modelKey,
          modelProvider: item.model.modelProvider,
          modelId: item.model.modelId,
          modelDisplayName: item.model.modelDisplayName,
          openRouterModelId: item.model.openRouterModelId,
          preferOpenRouter: item.model.preferOpenRouter,
          reasoning: input.reasoning,
          requestedIpHash: input.requestedIpHash,
          requestedUserAgentHash: input.requestedUserAgentHash,
          secret: {
            create: {
              provider: item.credential.provider,
              keyCiphertext: item.credential.keyCiphertext,
              keyIv: item.credential.keyIv,
              keyAuthTag: item.credential.keyAuthTag,
              keyVersion: item.credential.keyVersion,
              endpointCiphertext: item.endpoint?.ciphertext,
              endpointIv: item.endpoint?.iv,
              endpointAuthTag: item.endpoint?.authTag,
              expiresAt: new Date(now.getTime() + SECRET_TTL_MS),
            },
          },
          jobs: {
            create: {
              type: "generate",
              status: "queued",
              maxAttempts,
            },
          },
          events: {
            create: {
              seq: 1,
              type: "queued",
              data: { stage: "queued" },
            },
          },
        },
      });
    }
    await tx.customBuildStatsDaily.upsert({
      where: { day: dayKey(now) },
      create: { day: dayKey(now), created: prepared.length },
      update: { created: { increment: prepared.length } },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  return prepared.map((item) => ({ id: item.publicId, status: "queued" as const }));
}

type GenerationCursor = { createdAt: Date; id: string };

function decodeCursor(value?: string | null): GenerationCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    const createdAt = new Date(parsed[0]);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: parsed[1] };
  } catch {
    return null;
  }
}

function encodeCursor(value: GenerationCursor): string {
  return Buffer.from(JSON.stringify([value.createdAt.toISOString(), value.id])).toString("base64url");
}

export async function listSavedGenerations(
  ownerId: string,
  options: { cursor?: string | null; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
  const cursor = decodeCursor(options.cursor);
  const rows = await prisma.customBuild.findMany({
    where: {
      ownerId,
      removedAt: null,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    select: generationSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(serializeGeneration),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getSavedGeneration(ownerId: string, publicId: string) {
  const row = await prisma.customBuild.findFirst({
    where: { publicId, ownerId, removedAt: null },
    select: generationSelect,
  });
  return row ? serializeGeneration(row) : null;
}

export async function cancelSavedGeneration(ownerId: string, publicId: string) {
  const build = await prisma.customBuild.findFirst({
    where: { publicId, ownerId, removedAt: null },
    select: { id: true, status: true },
  });
  if (!build) throw new GenerationServiceError("not_found", "Saved generation not found.");
  if (build.status !== "queued" && build.status !== "running") {
    throw new GenerationServiceError("already_finished", "This generation has already finished.");
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const canceled = await tx.customBuild.updateMany({
      where: {
        id: build.id,
        ownerId,
        removedAt: null,
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "canceled",
        currentStage: "canceled",
        completedAt: now,
        errorCode: "canceled",
        errorMessage: "Generation stopped.",
        errorRetryable: false,
      },
    });
    if (canceled.count !== 1) {
      throw new GenerationServiceError("already_finished", "This generation has already finished.");
    }
    await tx.customBuildJob.updateMany({
      where: { customBuildId: build.id, status: { in: ["queued", "running"] } },
      data: {
        status: "canceled",
        completedAt: now,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    await tx.customBuildSecret.deleteMany({ where: { customBuildId: build.id } });
    await tx.customBuildStatsDaily.upsert({
      where: { day: dayKey(now) },
      create: { day: dayKey(now), canceled: 1 },
      update: { canceled: { increment: 1 } },
    });
  });
  return { id: publicId, status: "canceled" as const };
}

export async function getOwnedGenerationArtifact(
  ownerId: string,
  publicId: string,
  kinds: CustomBuildArtifactKind[],
) {
  return prisma.customBuildArtifact.findFirst({
    where: {
      kind: { in: kinds },
      customBuild: { publicId, ownerId, removedAt: null, status: "succeeded" },
    },
    select: {
      kind: true,
      bucket: true,
      path: true,
      contentType: true,
      encoding: true,
      fileName: true,
      sha256: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function removeSavedGeneration(
  ownerId: string,
  publicId: string,
  options: {
    acknowledgePublicExamples?: boolean;
    deleteArtifact?: typeof deleteCustomBuildArtifact;
  } = {},
) {
  const build = await prisma.customBuild.findFirst({
    where: { publicId, ownerId, removedAt: null },
    select: {
      id: true,
      promptText: true,
      galleryExamples: {
        where: { removedAt: null },
        select: { id: true, candidateId: true },
      },
    },
  });
  if (!build) throw new GenerationServiceError("not_found", "Saved generation not found.");
  if (build.galleryExamples.length > 0 && !options.acknowledgePublicExamples) {
    throw new GenerationServiceError(
      "public_examples_require_confirmation",
      "Removing this generation will also remove its Gallery examples.",
      { publicExampleCount: build.galleryExamples.length },
    );
  }

  const now = new Date();
  const purgeAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const artifacts = await prisma.$transaction(async (tx) => {
    const activeRemoval = await tx.customBuild.updateMany({
      where: {
        id: build.id,
        ownerId,
        removedAt: null,
        status: { in: ["queued", "running"] },
      },
      data: {
        removedAt: now,
        purgeAt,
        deletionPendingAt: now,
        deletionError: null,
        status: "canceled",
        currentStage: "canceled",
        completedAt: now,
        errorCode: "canceled",
        errorMessage: "Generation removed.",
        errorRetryable: false,
      },
    });
    if (activeRemoval.count === 0) {
      const terminalRemoval = await tx.customBuild.updateMany({
        where: { id: build.id, ownerId, removedAt: null },
        data: {
          removedAt: now,
          purgeAt,
          deletionPendingAt: now,
          deletionError: null,
        },
      });
      if (terminalRemoval.count !== 1) {
        throw new GenerationServiceError("not_found", "Saved generation not found.");
      }
    } else {
      await tx.customBuildJob.updateMany({
        where: { customBuildId: build.id, status: { in: ["queued", "running"] } },
        data: {
          status: "canceled",
          completedAt: now,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
        },
      });
      await tx.customBuildSecret.deleteMany({ where: { customBuildId: build.id } });
    }
    await tx.galleryExample.updateMany({
      where: { customBuildId: build.id, removedAt: null },
      data: { removedAt: now, purgeAt },
    });
    for (const example of build.galleryExamples) {
      await tx.galleryModerationRecord.create({
        data: {
          kind: "ADMIN_ACTION",
          target: "EXAMPLE",
          action: "generation_removed",
          actorUserId: ownerId,
          subjectUserId: ownerId,
          candidateId: example.candidateId,
          exampleId: example.id,
          safeSnapshot: { prompt: build.promptText },
          purgeAt,
        },
      });
    }
    return tx.customBuildArtifact.findMany({
      where: { customBuildId: build.id },
      select: { id: true, bucket: true, path: true },
    });
  });

  const removeObject = options.deleteArtifact ?? deleteCustomBuildArtifact;
  try {
    for (const artifact of artifacts) {
      await removeObject({ bucket: artifact.bucket, path: artifact.path });
    }
    await prisma.$transaction(async (tx) => {
      await tx.customBuildArtifact.deleteMany({
        where: { id: { in: artifacts.map((artifact) => artifact.id) } },
      });
      const remaining = await tx.customBuildArtifact.aggregate({
        where: { customBuildId: build.id },
        _sum: { storedByteSize: true },
        _count: true,
      });
      await tx.customBuild.update({
        where: { id: build.id },
        data: {
          storedByteSize: remaining._sum.storedByteSize ?? 0,
          objectsDeletedAt: remaining._count === 0 ? new Date() : null,
          deletionPendingAt: remaining._count === 0 ? null : new Date(),
          deletionError: remaining._count === 0 ? null : "Artifact cleanup pending.",
        },
      });
    });
  } catch (error) {
    await prisma.customBuild.update({
      where: { id: build.id },
      data: {
        deletionPendingAt: new Date(),
        deletionError: redactSensitiveText(error).slice(0, 500),
      },
    });
    throw new GenerationServiceError(
      "artifact_deletion_pending",
      "The generation is hidden while storage cleanup retries.",
    );
  }
  return { removed: true, publicExamplesRemoved: build.galleryExamples.length };
}
