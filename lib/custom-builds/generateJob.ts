import type { CustomBuild, CustomBuildJob, Prisma } from "@prisma/client";
import type { ModelKey } from "@/lib/ai/modelCatalog";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { MAX_BLOCKS_BY_GRID, type GridSize } from "@/lib/ai/limits";
import type { ProviderApiKeys } from "@/lib/ai/types";
import { getPalette } from "@/lib/blocks/palettes";
import {
  buildCustomBuildPreview,
  gzipBytes,
  jsonBytes,
  sha256Hex,
  uploadAndRecordCustomBuildArtifact,
} from "@/lib/custom-builds/artifacts";
import { appendCustomBuildEvent } from "@/lib/custom-builds/events";
import { decryptProviderKey } from "@/lib/custom-builds/secrets";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import type { CustomBuildExportFormat } from "@/lib/custom-builds/types";
import { prisma } from "@/lib/prisma";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";

type GenerateJobPayload = {
  requestedExports?: CustomBuildExportFormat[];
  stubBuild?: unknown;
};

function asGenerateJobPayload(payload: Prisma.JsonValue | null): GenerateJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload as GenerateJobPayload;
}

function assertGridSize(value: number): GridSize {
  if (value === 64 || value === 256 || value === 512) return value;
  throw new Error(`Unsupported custom build grid size: ${value}`);
}

function providerKeysForSecret(provider: string, providerKey: string): ProviderApiKeys {
  if (provider === "openrouter") return { openrouter: providerKey };
  if (provider === "openai") return { openai: providerKey };
  if (provider === "anthropic") return { anthropic: providerKey };
  if (provider === "gemini") return { gemini: providerKey };
  if (provider === "moonshot") return { moonshot: providerKey };
  if (provider === "deepseek") return { deepseek: providerKey };
  if (provider === "minimax") return { minimax: providerKey };
  if (provider === "xai") return { xai: providerKey };
  if (provider === "custom") return { custom: providerKey };
  return {};
}

function validateStubBuild(build: unknown, customBuild: CustomBuild): { build: VoxelBuild; warnings: string[] } {
  const gridSize = assertGridSize(customBuild.gridSize);
  const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
  const validated = validateVoxelBuild(build, {
    gridSize,
    palette: getPalette(palette),
    maxBlocks: MAX_BLOCKS_BY_GRID[gridSize],
  });
  if (!validated.ok) {
    throw new Error(`Stub custom build is invalid: ${validated.error}`);
  }
  return validated.value;
}

async function generateBuild(customBuild: CustomBuild, job: CustomBuildJob): Promise<{
  build: VoxelBuild;
  warnings: string[];
  blockCount: number;
  generationTimeMs: number;
}> {
  const payload = asGenerateJobPayload(job.payload);
  if (payload.stubBuild) {
    if (process.env.CUSTOM_BUILD_STUB_PROVIDER !== "1") {
      throw new Error("Stub custom build jobs require CUSTOM_BUILD_STUB_PROVIDER=1");
    }
    const started = Date.now();
    const validated = validateStubBuild(payload.stubBuild, customBuild);
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
  });
  const gridSize = assertGridSize(customBuild.gridSize);
  const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
  const providerKeys = providerKeysForSecret(secret.provider, providerKey);

  const result = await generateVoxelBuild(
    customBuild.modelKind === "catalog" && customBuild.modelKey
      ? {
          modelKey: customBuild.modelKey as ModelKey,
          prompt: customBuild.promptText,
          gridSize,
          palette,
          providerKeys,
          allowServerKeys: false,
          preferOpenRouter: customBuild.preferOpenRouter,
          reasoning: customBuild.reasoning ?? undefined,
          onRetry: (attempt, reason) =>
            void appendCustomBuildEvent(customBuild.id, "retry", { attempt, reason: redactSensitiveText(reason) }),
          onProviderTrace: (message) =>
            void appendCustomBuildEvent(customBuild.id, "provider_trace", {
              message: redactSensitiveText(message),
            }),
        }
      : {
          model: {
            key: customBuild.publicId,
            provider: "custom",
            modelId: customBuild.modelId,
            displayName: customBuild.modelDisplayName,
            baseUrl: customBuild.customBaseUrl ?? undefined,
          },
          prompt: customBuild.promptText,
          gridSize,
          palette,
          providerKeys,
          allowServerKeys: false,
          reasoning: customBuild.reasoning ?? undefined,
          onRetry: (attempt, reason) =>
            void appendCustomBuildEvent(customBuild.id, "retry", { attempt, reason: redactSensitiveText(reason) }),
          onProviderTrace: (message) =>
            void appendCustomBuildEvent(customBuild.id, "provider_trace", {
              message: redactSensitiveText(message),
            }),
        },
  );

  if (!result.ok) {
    throw new Error(redactSensitiveText(result.error));
  }
  return {
    build: result.build,
    warnings: result.warnings,
    blockCount: result.blockCount,
    generationTimeMs: result.generationTimeMs,
  };
}

export async function runCustomBuildGenerateJob(job: CustomBuildJob): Promise<void> {
  const customBuild = await prisma.customBuild.findUnique({
    where: { id: job.customBuildId },
  });
  if (!customBuild) throw new Error("Custom build not found");

  await prisma.customBuild.update({
    where: { id: customBuild.id },
    data: {
      status: "running",
      startedAt: customBuild.startedAt ?? new Date(),
      currentStage: "generating",
    },
  });
  await appendCustomBuildEvent(customBuild.id, "started", { stage: "generating" });

  try {
    const generated = await generateBuild(customBuild, job);
    const fullBytes = jsonBytes(generated.build);
    const fullSha = sha256Hex(fullBytes);
    const fullGzip = gzipBytes(fullBytes);
    await uploadAndRecordCustomBuildArtifact({
      customBuildId: customBuild.id,
      publicId: customBuild.publicId,
      kind: "build_json",
      bytes: fullGzip,
      uncompressedByteSize: fullBytes.byteLength,
      sha256: fullSha,
      blockCount: generated.blockCount,
      encoding: "gzip",
    });
    await appendCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "build_json" });

    const preview = buildCustomBuildPreview(generated.build);
    const previewBytes = jsonBytes(preview);
    const previewSha = sha256Hex(previewBytes);
    const previewGzip = gzipBytes(previewBytes);
    await uploadAndRecordCustomBuildArtifact({
      customBuildId: customBuild.id,
      publicId: customBuild.publicId,
      kind: "preview_json",
      bytes: previewGzip,
      uncompressedByteSize: previewBytes.byteLength,
      sha256: previewSha,
      sourceBuildSha256: fullSha,
      blockCount: preview.blocks.length,
      encoding: "gzip",
    });
    await appendCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "preview_json" });

    const payload = asGenerateJobPayload(job.payload);
    const requestedExports = payload.requestedExports ?? [];
    await prisma.customBuild.update({
      where: { id: customBuild.id },
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
        buildByteSize: fullBytes.byteLength,
        buildCompressedByteSize: fullGzip.byteLength,
        previewBlockCount: preview.blocks.length,
        previewSha256: previewSha,
      },
    });

    for (const format of requestedExports) {
      await prisma.customBuildJob.create({
        data: {
          customBuildId: customBuild.id,
          type: "export",
          status: "queued",
          payload: { format },
          maxAttempts: job.maxAttempts,
        },
      });
      await appendCustomBuildEvent(customBuild.id, "export_queued", { format });
    }

    await prisma.customBuildStatsDaily.upsert({
      where: { day: new Date(new Date().toISOString().slice(0, 10)) },
      create: { day: new Date(new Date().toISOString().slice(0, 10)), succeeded: 1 },
      update: { succeeded: { increment: 1 } },
    });
    await prisma.customBuildSecret.deleteMany({ where: { customBuildId: customBuild.id } });
    await appendCustomBuildEvent(customBuild.id, "complete", { stage: "complete" });
  } catch (error) {
    const message = redactSensitiveText(error);
    await prisma.customBuild.update({
      where: { id: customBuild.id },
      data: {
        status: "failed",
        currentStage: "failed",
        completedAt: new Date(),
        errorCode: message === "provider_key_expired" ? "provider_key_expired" : "worker_failed",
        errorMessage: message === "provider_key_expired" ? "Provider key expired before the worker could start." : message,
        errorRetryable: message !== "provider_key_expired",
      },
    });
    await prisma.customBuildStatsDaily.upsert({
      where: { day: new Date(new Date().toISOString().slice(0, 10)) },
      create: { day: new Date(new Date().toISOString().slice(0, 10)), failed: 1 },
      update: { failed: { increment: 1 } },
    });
    await prisma.customBuildSecret.deleteMany({ where: { customBuildId: customBuild.id } });
    await appendCustomBuildEvent(customBuild.id, "failed", { message });
    throw error;
  }
}
