import type { CustomBuild, CustomBuildJob, Prisma } from "@prisma/client";
import type { Provider } from "@/lib/ai/modelCatalog";
import { generateVoxelBuild, type GenerateVoxelBuildParams } from "@/lib/ai/generateVoxelBuild";
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

type GenerateVoxelBuildModel = NonNullable<GenerateVoxelBuildParams["model"]>;

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

function customBuildModelForGeneration(customBuild: CustomBuild): GenerateVoxelBuildModel {
  return {
    key: customBuild.modelKind === "catalog" && customBuild.modelKey ? customBuild.modelKey : customBuild.publicId,
    provider: customBuildProviderForGeneration(customBuild.modelProvider),
    modelId: customBuild.modelId,
    displayName: customBuild.modelDisplayName,
    openRouterModelId: customBuild.openRouterModelId ?? undefined,
    baseUrl: customBuild.customBaseUrl ?? undefined,
  };
}

export function isTerminalCustomBuildGenerateError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
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
  });
  const gridSize = assertGridSize(customBuild.gridSize);
  const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
  const providerKeys = providerKeysForSecret(secret.provider, providerKey);

  const result = await generateVoxelBuild(
    {
      model: customBuildModelForGeneration(customBuild),
      prompt: customBuild.promptText,
      gridSize,
      palette,
      providerKeys,
      allowServerKeys: false,
      preferOpenRouter: customBuild.preferOpenRouter,
      reasoning: customBuild.reasoning ?? undefined,
      onRetry: (attempt, reason) =>
        emitCustomBuildEvent(customBuild.id, "retry", { attempt, reason: redactSensitiveText(reason) }),
      onProviderTrace: (message) =>
        emitCustomBuildEvent(customBuild.id, "provider_trace", {
          message: redactSensitiveText(message),
        }),
    },
  );

  if (!result.ok) {
    throw new Error(redactSensitiveText(result.error));
  }
  const artifactBuild = validateGeneratedBuildForArtifacts(result.build, customBuild);
  const warnings = Array.from(new Set([...result.warnings, ...artifactBuild.warnings]));
  return {
    build: artifactBuild.build,
    warnings,
    blockCount: artifactBuild.build.blocks.length,
    generationTimeMs: result.generationTimeMs,
  };
}

export async function runCustomBuildGenerateJob(job: CustomBuildJob): Promise<void> {
  const customBuild = await prisma.customBuild.findUnique({
    where: { id: job.customBuildId },
  });
  if (!customBuild) throw new Error("Custom build not found");
  if (customBuild.status === "succeeded") return;

  await prisma.customBuild.update({
    where: { id: customBuild.id },
    data: {
      status: "running",
      startedAt: customBuild.startedAt ?? new Date(),
      currentStage: "generating",
    },
  });
  emitCustomBuildEvent(customBuild.id, "started", { stage: "generating" });

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
    emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "build_json" });

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
    emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "preview_json" });

    const payload = asGenerateJobPayload(job.payload);
    const requestedExports = payload.requestedExports ?? [];
    await prisma.$transaction(async (tx) => {
      await tx.customBuild.update({
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
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
        },
      });

      for (const format of requestedExports) {
        await tx.customBuildJob.create({
          data: {
            customBuildId: customBuild.id,
            type: "export",
            status: "queued",
            payload: { format, sourceBuildSha256: fullSha },
            maxAttempts: job.maxAttempts,
          },
        });
      }

      await tx.customBuildStatsDaily.upsert({
        where: { day: new Date(new Date().toISOString().slice(0, 10)) },
        create: { day: new Date(new Date().toISOString().slice(0, 10)), succeeded: 1 },
        update: { succeeded: { increment: 1 } },
      });
      await tx.customBuildSecret.deleteMany({ where: { customBuildId: customBuild.id } });
    });

    for (const format of requestedExports) {
      emitCustomBuildEvent(customBuild.id, "export_queued", { format });
    }

    emitCustomBuildEvent(customBuild.id, "complete", { stage: "complete" });
  } catch (error) {
    const message = redactSensitiveText(error);
    const terminal = isTerminalCustomBuildGenerateError(message) || job.attempts >= job.maxAttempts;
    if (terminal) {
      await prisma.customBuild.update({
        where: { id: customBuild.id },
        data: {
          status: "failed",
          currentStage: "failed",
          completedAt: new Date(),
          errorCode: message === "provider_key_expired" ? "provider_key_expired" : "worker_failed",
          errorMessage: message === "provider_key_expired" ? "Provider key expired before the worker could start." : message,
          errorRetryable: false,
        },
      });
      await prisma.customBuildStatsDaily.upsert({
        where: { day: new Date(new Date().toISOString().slice(0, 10)) },
        create: { day: new Date(new Date().toISOString().slice(0, 10)), failed: 1 },
        update: { failed: { increment: 1 } },
      });
      await prisma.customBuildSecret.deleteMany({ where: { customBuildId: customBuild.id } });
      emitCustomBuildEvent(customBuild.id, "failed", { message });
    } else {
      await prisma.customBuild.update({
        where: { id: customBuild.id },
        data: {
          status: "queued",
          currentStage: "queued",
          errorCode: "worker_failed",
          errorMessage: message,
          errorRetryable: true,
        },
      });
      emitCustomBuildEvent(customBuild.id, "retry", {
        attempt: job.attempts,
        reason: message,
      });
    }
    throw error;
  }
}
