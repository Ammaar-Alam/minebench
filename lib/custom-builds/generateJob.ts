import { Prisma, type CustomBuild, type CustomBuildJob } from "@prisma/client";
import type { Provider } from "@/lib/ai/modelCatalog";
import { generateVoxelBuild, type GenerateVoxelBuildParams } from "@/lib/ai/generateVoxelBuild";
import { MAX_BLOCKS_BY_GRID, type GridSize } from "@/lib/ai/limits";
import type { ProviderApiKeys } from "@/lib/ai/types";
import { encodeBinaryArtifact } from "@/lib/arena/binaryArtifact";
import { ARENA_MESH_FACTS_MIN_BLOCKS } from "@/lib/arena/types";
import { getPalette } from "@/lib/blocks/palettes";
import {
  buildCustomBuildPreview,
  decodeAndVerifyCustomBuildArtifactText,
  gzipBytes,
  sha256Hex,
  uploadAndRecordCustomBuildArtifact,
  writeCanonicalBuildArtifact,
} from "@/lib/custom-builds/artifacts";
import { appendCustomBuildEvent } from "@/lib/custom-builds/events";
import {
  CustomBuildLeaseLostError,
  isCustomBuildLeaseLostError,
  throwIfCustomBuildLeaseLost,
} from "@/lib/custom-builds/lease";
import { decryptProviderKey, decryptSecretValue } from "@/lib/custom-builds/secrets";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import {
  assertCustomBuildStorageConfigured,
  downloadCustomBuildArtifactBytes,
} from "@/lib/custom-builds/storage";
import { prisma } from "@/lib/prisma";
import { buildGalleryPreviewSvg } from "@/lib/gallery/preview";
import { packVoxelBlocks } from "@/lib/voxel/packedBlocks";
import { createVoxelMeshFacts, encodeVoxelMeshFacts } from "@/lib/voxel/meshFacts";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";

type GenerateJobPayload = {
  stubBuild?: unknown;
};

type GenerateVoxelBuildModel = NonNullable<GenerateVoxelBuildParams["model"]>;

type GeneratedBuildResult = {
  build: VoxelBuild;
  warnings: string[];
  blockCount: number;
  generationTimeMs: number | null;
};

const CUSTOM_BUILD_MODEL_MAX_ATTEMPTS = 2;

class CustomBuildGenerationFailedError extends Error {
  constructor(
    readonly reason: string,
    readonly attempt: number,
  ) {
    super(reason);
    this.name = "CustomBuildGenerationFailedError";
  }
}

function asGenerateJobPayload(payload: Prisma.JsonValue | null): GenerateJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload as GenerateJobPayload;
}

function assertGridSize(value: number): GridSize {
  if (value === 64 || value === 256 || value === 512) return value;
  throw new Error(`Unsupported custom build grid size: ${value}`);
}

export function providerKeysForSecret(provider: string, providerKey: string): ProviderApiKeys {
  if (provider === "openrouter") return { openrouter: providerKey };
  if (provider === "openai") return { openai: providerKey };
  if (provider === "anthropic") return { anthropic: providerKey };
  if (provider === "gemini") return { gemini: providerKey };
  if (provider === "moonshot") return { moonshot: providerKey };
  if (provider === "deepseek") return { deepseek: providerKey };
  if (provider === "minimax") return { minimax: providerKey };
  if (provider === "xai") return { xai: providerKey };
  if (provider === "meta") return { meta: providerKey };
  if (provider === "zai") return { zai: providerKey };
  if (provider === "custom") return { custom: providerKey };
  return {};
}

function customBuildProviderForGeneration(provider: string): Provider | "custom" {
  if (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "gemini" ||
    provider === "moonshot" ||
    provider === "deepseek" ||
    provider === "xai" ||
    provider === "zai" ||
    provider === "qwen" ||
    provider === "minimax" ||
    provider === "meta" ||
    provider === "custom"
  ) {
    return provider;
  }
  throw new Error(`Unsupported custom build model provider: ${provider}`);
}

export function customBuildModelForGeneration(
  customBuild: CustomBuild,
  customBaseUrl?: string,
): GenerateVoxelBuildModel {
  return {
    key: customBuild.modelKind === "catalog" && customBuild.modelKey ? customBuild.modelKey : customBuild.publicId,
    provider: customBuildProviderForGeneration(customBuild.modelProvider),
    modelId: customBuild.modelId,
    displayName: customBuild.modelDisplayName,
    openRouterModelId: customBuild.openRouterModelId ?? undefined,
    forceOpenRouter: customBuild.modelKind === "openrouter",
    baseUrl: customBaseUrl,
  };
}

class CustomBuildArtifactPersistenceError extends Error {
  constructor(error: unknown) {
    super(`custom_build_artifact_persistence_failed: ${redactSensitiveText(error)}`);
    this.name = "CustomBuildArtifactPersistenceError";
  }
}

class CustomBuildArtifactBookkeepingError extends Error {
  constructor(error: unknown) {
    super(`custom_build_artifact_bookkeeping_failed: ${redactSensitiveText(error)}`);
    this.name = "CustomBuildArtifactBookkeepingError";
  }
}

function isCustomBuildArtifactPersistenceError(error: unknown): error is CustomBuildArtifactPersistenceError {
  return error instanceof CustomBuildArtifactPersistenceError;
}

function isCustomBuildArtifactBookkeepingError(error: unknown): error is CustomBuildArtifactBookkeepingError {
  return error instanceof CustomBuildArtifactBookkeepingError;
}

function safeGenerateFailure(error: unknown, message: string) {
  if (message === "provider_key_expired") {
    return { code: "provider_key_expired", message: "Provider key expired before the worker could start." };
  }
  if (isCustomBuildArtifactPersistenceError(error)) {
    return { code: "artifact_persistence_failed", message: "The generated result could not be saved." };
  }
  if (isCustomBuildArtifactBookkeepingError(error)) {
    return { code: "artifact_bookkeeping_failed", message: "The saved generation could not be completed." };
  }
  if (isTerminalCustomBuildGenerateError(message)) {
    return { code: "provider_rejected", message: "The provider rejected this generation request." };
  }
  if (error instanceof CustomBuildGenerationFailedError) {
    return { code: "generation_failed", message: "No valid build was returned." };
  }
  return { code: "generation_failed", message: "Generation failed. Try again." };
}

async function persistCustomBuildArtifact(args: Parameters<typeof uploadAndRecordCustomBuildArtifact>[0]) {
  try {
    return await uploadAndRecordCustomBuildArtifact(args);
  } catch (error) {
    throw new CustomBuildArtifactPersistenceError(error);
  }
}

export function isTerminalCustomBuildGenerateError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (normalized.includes("custom_build_artifact_persistence_failed")) return true;
  if (normalized === "provider_key_expired") return true;
  if (normalized.includes("invalid_api_key")) return true;
  if (normalized.includes("invalid api key") || normalized.includes("incorrect api key")) return true;
  if (normalized.includes("api key") && normalized.includes("invalid")) return true;
  if (/\berror\s+(401|403)\b/.test(normalized)) return true;
  if (normalized.includes("unauthorized") || normalized.includes("forbidden")) return true;
  if (normalized.includes("authentication") || normalized.includes("permission denied")) return true;
  if (normalized.includes("missing ") && (normalized.includes("api_key") || normalized.includes("api key"))) {
    return true;
  }
  if (normalized.includes("openrouter routing requested")) return true;
  if (normalized.includes("openrouter routing is unavailable")) return true;
  if (normalized.includes("not integrated with openrouter")) return true;
  if (normalized.includes("no openrouter model id configured")) return true;
  if (normalized.includes("direct api not supported; use openrouter fallback")) return true;
  return (
    normalized.includes("output_config.format.schema") ||
    (normalized.includes("json_schema") && normalized.includes("not supported")) ||
    (normalized.includes("structured output") && normalized.includes("not supported")) ||
    (normalized.includes("structured output") && normalized.includes("invalid"))
  );
}

export function validateGeneratedBuildForArtifacts(
  build: unknown,
  customBuild: Pick<CustomBuild, "gridSize" | "palette">,
): { build: VoxelBuild; warnings: string[] } {
  const gridSize = assertGridSize(customBuild.gridSize);
  const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
  const validated = validateVoxelBuild(build, {
    gridSize,
    palette: getPalette(palette),
    maxBlocks: MAX_BLOCKS_BY_GRID[gridSize],
  });
  if (!validated.ok) {
    throw new Error(`Generated custom build is invalid: ${validated.error}`);
  }
  return validated.value;
}

function emitCustomBuildEvent(customBuildId: string, type: string, data: Prisma.InputJsonValue): void {
  void appendCustomBuildEvent(customBuildId, type, data).catch((error) => {
    console.warn(`custom build event write failed for ${customBuildId}:`, redactSensitiveText(error));
  });
}

async function generateBuild(
  customBuild: CustomBuild,
  job: CustomBuildJob,
  opts: {
    signal?: AbortSignal;
    acquireBuildProcessing?: () => Promise<() => void>;
  } = {},
): Promise<GeneratedBuildResult> {
  throwIfCustomBuildLeaseLost(opts.signal);
  const payload = asGenerateJobPayload(job.payload);
  if (payload.stubBuild) {
    if (process.env.CUSTOM_BUILD_STUB_PROVIDER !== "1") {
      throw new Error("Stub custom build jobs require CUSTOM_BUILD_STUB_PROVIDER=1");
    }
    const started = Date.now();
    await opts.acquireBuildProcessing?.();
    throwIfCustomBuildLeaseLost(opts.signal);
    const validated = validateGeneratedBuildForArtifacts(payload.stubBuild, customBuild);
    return {
      build: validated.build,
      warnings: validated.warnings,
      blockCount: validated.build.blocks.length,
      generationTimeMs: Date.now() - started,
    };
  }

  const secret = await prisma.customBuildSecret.findUnique({
    where: { customBuildId: customBuild.id },
  });
  if (!secret || secret.deletedAt) {
    throw new Error("provider_key_expired");
  }
  if (secret.expiresAt.getTime() <= Date.now()) {
    throw new Error("provider_key_expired");
  }
  const providerKey = decryptProviderKey({
    provider: secret.provider,
    keyCiphertext: secret.keyCiphertext,
    keyIv: secret.keyIv,
    keyAuthTag: secret.keyAuthTag ?? "",
    keyVersion: secret.keyVersion,
  }, customBuild.id);
  const customBaseUrl =
    secret.endpointCiphertext && secret.endpointIv && secret.endpointAuthTag
      ? decryptSecretValue(
          {
            ciphertext: secret.endpointCiphertext,
            iv: secret.endpointIv,
            authTag: secret.endpointAuthTag,
            keyVersion: secret.keyVersion,
          },
          customBuild.id,
        )
      : undefined;
  const gridSize = assertGridSize(customBuild.gridSize);
  const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
  const providerKeys = providerKeysForSecret(secret.provider, providerKey);
  let providerAttempts = 0;

  throwIfCustomBuildLeaseLost(opts.signal);
  const result = await generateVoxelBuild(
    {
      model: customBuildModelForGeneration(customBuild, customBaseUrl),
      prompt: customBuild.promptText,
      gridSize,
      palette,
      providerKeys,
      allowServerKeys: false,
      preferOpenRouter: customBuild.preferOpenRouter,
      reasoning: customBuild.reasoning ?? undefined,
      abortSignal: opts.signal,
      maxAttempts: CUSTOM_BUILD_MODEL_MAX_ATTEMPTS,
      onProviderRequest: (attempt) => {
        providerAttempts = Math.max(providerAttempts, attempt);
      },
      onRetry: async (attempt, reason) => {
        const safeReason = redactSensitiveText(reason, 1_000) || "The model response could not be used.";
        const retrying = await prisma.customBuild.updateMany({
          where: { id: customBuild.id, removedAt: null, status: "running" },
          data: {
            currentStage: "retrying",
            progress: { attempt, reason: safeReason },
          },
        });
        if (retrying.count !== 1) throw new CustomBuildLeaseLostError();
        await appendCustomBuildEvent(customBuild.id, "retry", { attempt, reason: safeReason });
      },
      acquireBuildProcessing: opts.acquireBuildProcessing,
      returnExpandedBuild: true,
    },
  );

  throwIfCustomBuildLeaseLost(opts.signal);
  if (!result.ok) {
    throw new CustomBuildGenerationFailedError(
      redactSensitiveText(result.error, 1_000) || "The model response could not be used.",
      Math.max(1, providerAttempts),
    );
  }
  return {
    build: result.build,
    warnings: result.warnings,
    blockCount: result.blockCount,
    generationTimeMs: result.generationTimeMs,
  };
}

function persistedWarnings(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value)
    ? value.filter((warning): warning is string => typeof warning === "string")
    : [];
}

async function recoverStoredBuild(
  customBuild: CustomBuild,
  opts: {
    signal?: AbortSignal;
    acquireBuildProcessing?: () => Promise<() => void>;
  } = {},
): Promise<GeneratedBuildResult | null> {
  const artifact = await prisma.customBuildArtifact.findFirst({
    where: { customBuildId: customBuild.id, kind: "build_json" },
    select: {
      bucket: true,
      path: true,
      encoding: true,
      sha256: true,
      sourceBuildSha256: true,
      blockCount: true,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!artifact) return null;
  try {
    await opts.acquireBuildProcessing?.();
    throwIfCustomBuildLeaseLost(opts.signal);
    if (artifact.encoding !== "gzip" || !artifact.sourceBuildSha256) {
      throw new Error("Stored canonical artifact metadata is incomplete");
    }
    const bytes = await downloadCustomBuildArtifactBytes(artifact);
    const canonicalText = decodeAndVerifyCustomBuildArtifactText({
      bytes,
      encoding: artifact.encoding,
      storedSha256: artifact.sha256,
      sourceSha256: artifact.sourceBuildSha256,
    });
    const validated = validateGeneratedBuildForArtifacts(JSON.parse(canonicalText), customBuild);
    if (artifact.blockCount != null && artifact.blockCount !== validated.build.blocks.length) {
      throw new Error("Stored canonical block count does not match");
    }
    return {
      build: validated.build,
      warnings: Array.from(new Set([
        ...persistedWarnings(customBuild.warnings),
        ...validated.warnings,
      ])),
      blockCount: validated.build.blocks.length,
      generationTimeMs: customBuild.generationTimeMs,
    };
  } catch (error) {
    throw new CustomBuildArtifactBookkeepingError(error);
  }
}

export async function runCustomBuildGenerateJob(
  job: CustomBuildJob,
  opts: {
    signal?: AbortSignal;
    acquireBuildProcessing?: () => Promise<() => void>;
    beforeSynchronousArtifactPackaging?: () => Promise<void> | void;
  } = {},
): Promise<void> {
  const customBuild = await prisma.customBuild.findUnique({
    where: { id: job.customBuildId },
  });
  if (!customBuild) throw new Error("Custom build not found");
  if (customBuild.status === "succeeded") return;
  throwIfCustomBuildLeaseLost(opts.signal);

  const started = await prisma.customBuild.updateMany({
    where: {
      id: customBuild.id,
      removedAt: null,
      status: { in: ["queued", "running"] },
    },
    data: {
      status: "running",
      startedAt: customBuild.startedAt ?? new Date(),
      currentStage: "generating",
    },
  });
  if (started.count !== 1) throw new CustomBuildLeaseLostError();
  emitCustomBuildEvent(customBuild.id, "started", { stage: "generating" });

  let artifactsPersisted = false;
  try {
    try {
      assertCustomBuildStorageConfigured();
    } catch (error) {
      throw new CustomBuildArtifactPersistenceError(error);
    }
    const recovered = await recoverStoredBuild(customBuild, opts);
    const generated = recovered ?? await generateBuild(customBuild, job, opts);
    if (recovered) emitCustomBuildEvent(customBuild.id, "recovered", { stage: "finalizing" });
    throwIfCustomBuildLeaseLost(opts.signal);
    await opts.beforeSynchronousArtifactPackaging?.();
    throwIfCustomBuildLeaseLost(opts.signal);
    const canonicalBuild: VoxelBuild = {
      version: "1.0",
      blocks: generated.build.blocks.sort(
        (a, b) => a.x - b.x || a.y - b.y || a.z - b.z || a.type.localeCompare(b.type),
      ),
    };
    const canonicalArtifact = await writeCanonicalBuildArtifact(canonicalBuild);
    const buildByteSize = canonicalArtifact.byteSize;
    const buildCompressedByteSize = canonicalArtifact.storedByteSize;
    const fullSha = canonicalArtifact.sourceSha256;
    try {
      throwIfCustomBuildLeaseLost(opts.signal);
      await persistCustomBuildArtifact({
        customBuildId: customBuild.id,
        publicId: customBuild.publicId,
        kind: "build_json",
        filePath: canonicalArtifact.filePath,
        storedByteSize: canonicalArtifact.storedByteSize,
        uncompressedByteSize: canonicalArtifact.byteSize,
        sha256: canonicalArtifact.sha256,
        sourceBuildSha256: fullSha,
        blockCount: generated.blockCount,
        encoding: "gzip",
      });
    } finally {
      await canonicalArtifact.cleanup();
    }
    artifactsPersisted = true;
    emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "build_json" });

    throwIfCustomBuildLeaseLost(opts.signal);
    const preview = buildCustomBuildPreview(canonicalBuild);
    const previewBytes = encodeBinaryArtifact(
      {
        buildId: customBuild.publicId,
        variant: "preview",
        checksum: fullSha,
        serverValidated: true,
        version: preview.version,
      },
      preview.blocks,
      fullSha,
    );
    const previewGzip = gzipBytes(previewBytes);
    const previewArtifactSha = sha256Hex(previewGzip);
    throwIfCustomBuildLeaseLost(opts.signal);
    await persistCustomBuildArtifact({
      customBuildId: customBuild.id,
      publicId: customBuild.publicId,
      kind: "preview_mbv4",
      bytes: previewGzip,
      uncompressedByteSize: previewBytes.byteLength,
      sha256: previewArtifactSha,
      sourceBuildSha256: fullSha,
      blockCount: preview.blocks.length,
      encoding: "gzip",
    });
    emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "preview_mbv4" });

    throwIfCustomBuildLeaseLost(opts.signal);
    const viewerKind =
      canonicalBuild.blocks.length >= ARENA_MESH_FACTS_MIN_BLOCKS
        ? "viewer_mbf1"
        : "viewer_mbv4";
    const viewerBytes =
      viewerKind === "viewer_mbf1"
        ? encodeVoxelMeshFacts(createVoxelMeshFacts(packVoxelBlocks(canonicalBuild.blocks)))
        : encodeBinaryArtifact(
            {
              buildId: customBuild.publicId,
              variant: "full",
              checksum: fullSha,
              serverValidated: true,
              version: canonicalBuild.version,
            },
            canonicalBuild.blocks,
            fullSha,
          );
    const viewerGzip = gzipBytes(viewerBytes);
    await persistCustomBuildArtifact({
      customBuildId: customBuild.id,
      publicId: customBuild.publicId,
      kind: viewerKind,
      bytes: viewerGzip,
      uncompressedByteSize: viewerBytes.byteLength,
      sha256: sha256Hex(viewerGzip),
      sourceBuildSha256: fullSha,
      blockCount: canonicalBuild.blocks.length,
      encoding: "gzip",
    });
    emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: viewerKind });

    throwIfCustomBuildLeaseLost(opts.signal);
    const previewSvg = new TextEncoder().encode(buildGalleryPreviewSvg(canonicalBuild));
    await persistCustomBuildArtifact({
      customBuildId: customBuild.id,
      publicId: customBuild.publicId,
      kind: "preview_svg",
      bytes: previewSvg,
      sha256: sha256Hex(previewSvg),
      sourceBuildSha256: fullSha,
      blockCount: canonicalBuild.blocks.length,
    });
    emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "preview_svg" });
    artifactsPersisted = true;

    throwIfCustomBuildLeaseLost(opts.signal);
    await prisma.$transaction(async (tx) => {
      const stored = await tx.customBuildArtifact.aggregate({
        where: { customBuildId: customBuild.id },
        _sum: { storedByteSize: true },
      });
      const completed = await tx.customBuild.updateMany({
        where: { id: customBuild.id, removedAt: null, status: "running" },
        data: {
          status: "succeeded",
          currentStage: "complete",
          completedAt: new Date(),
          blockCount: generated.blockCount,
          generationTimeMs: generated.generationTimeMs,
          warnings: generated.warnings,
          metrics: {
            blockCount: generated.blockCount,
            generationTimeMs: generated.generationTimeMs,
            warnings: generated.warnings,
          },
          buildSha256: fullSha,
          buildByteSize,
          buildCompressedByteSize,
          previewBlockCount: preview.blocks.length,
          previewSha256: previewArtifactSha,
          storedByteSize: stored._sum.storedByteSize ?? 0,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          progress: Prisma.DbNull,
        },
      });
      if (completed.count !== 1) throw new CustomBuildLeaseLostError();

      await tx.customBuildStatsDaily.upsert({
        where: { day: new Date(new Date().toISOString().slice(0, 10)) },
        create: { day: new Date(new Date().toISOString().slice(0, 10)), succeeded: 1 },
        update: { succeeded: { increment: 1 } },
      });
      await tx.customBuildSecret.deleteMany({ where: { customBuildId: customBuild.id } });
    });

    throwIfCustomBuildLeaseLost(opts.signal);
    throwIfCustomBuildLeaseLost(opts.signal);
    emitCustomBuildEvent(customBuild.id, "complete", { stage: "complete" });
  } catch (error) {
    if (isCustomBuildLeaseLostError(error)) throw error;
    const effectiveError =
      artifactsPersisted && !isCustomBuildArtifactPersistenceError(error)
        ? new CustomBuildArtifactBookkeepingError(error)
        : error;
    const message = redactSensitiveText(effectiveError);
    const manuallyRetryable =
      effectiveError instanceof CustomBuildGenerationFailedError &&
      !isTerminalCustomBuildGenerateError(message);
    const terminal =
      isCustomBuildArtifactPersistenceError(effectiveError) ||
      effectiveError instanceof CustomBuildGenerationFailedError ||
      isTerminalCustomBuildGenerateError(message) ||
      job.attempts >= job.maxAttempts;
    if (terminal) {
      const failure = safeGenerateFailure(effectiveError, message);
      const failed = await prisma.customBuild.updateMany({
        where: { id: customBuild.id, removedAt: null, status: "running" },
        data: {
          status: "failed",
          currentStage: "failed",
          completedAt: new Date(),
          errorCode: failure.code,
          errorMessage: failure.message,
          errorRetryable: manuallyRetryable,
          progress: effectiveError instanceof CustomBuildGenerationFailedError
            ? { attempt: effectiveError.attempt, reason: effectiveError.reason }
            : Prisma.DbNull,
          objectsDeletedAt: null,
          deletionPendingAt: manuallyRetryable ? null : new Date(),
          deletionError: null,
        },
      });
      if (failed.count !== 1) throw new CustomBuildLeaseLostError();
      await prisma.customBuildStatsDaily.upsert({
        where: { day: new Date(new Date().toISOString().slice(0, 10)) },
        create: { day: new Date(new Date().toISOString().slice(0, 10)), failed: 1 },
        update: { failed: { increment: 1 } },
      });
      if (!manuallyRetryable) {
        await prisma.customBuildSecret.deleteMany({ where: { customBuildId: customBuild.id } });
      }
      emitCustomBuildEvent(customBuild.id, "failed", { code: failure.code });
      throw new Error(failure.code);
    } else {
      const requeued = await prisma.customBuild.updateMany({
        where: { id: customBuild.id, removedAt: null, status: "running" },
        data: {
          status: "queued",
          currentStage: "queued",
          errorCode: "generation_retrying",
          errorMessage: "Generation is retrying.",
          errorRetryable: true,
        },
      });
      if (requeued.count !== 1) throw new CustomBuildLeaseLostError();
      emitCustomBuildEvent(customBuild.id, "retry", {
        attempt: job.attempts,
      });
      throw new Error("generation_retryable");
    }
  }
}
