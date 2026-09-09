import { Prisma, type CustomBuild, type CustomBuildJob } from "@prisma/client";
import { enqueueGenerationNotification, lockNotificationAccounts } from "@/lib/notifications/service";
import {
  deserializeSavedGenerationRequestConfig,
  requestOverrideSecretValues,
  type SavedGenerationRequestConfig,
} from "@/lib/ai/customProviderConfig";
import type { Provider } from "@/lib/ai/modelCatalog";
import { isVoxelBuildResourceError, processVoxelBuildResponse, type ProcessVoxelBuildResponse } from "@/lib/ai/processVoxelBuildResponse";
import { generateVoxelBuild, type GenerateVoxelBuildParams } from "@/lib/ai/generateVoxelBuild";
import { MAX_BLOCKS_BY_GRID, type GridSize, isGridSize } from "@/lib/ai/limits";
import type { ProviderApiKeys } from "@/lib/ai/types";
import { encodeBinaryArtifact } from "@/lib/arena/binaryArtifact";
import { recordGenerationError, recordGenerationSuccess } from "@/lib/observability/cloudwatch";
import { ARENA_MESH_FACTS_MIN_BLOCKS } from "@/lib/arena/types";
import { getPalette } from "@/lib/blocks/palettes";
import {
  buildCustomBuildPreview,
  decodeAndVerifyCustomBuildArtifactText,
  getCustomBuildPreviewTargetBlocks,
  gzipBytes,
  readStoredBuildSource,
  sha256Hex,
  uploadAndRecordCustomBuildArtifact,
  writeCanonicalBuildArtifact,
  writeVoxelBuildSourceArtifact,
} from "@/lib/custom-builds/artifacts";
import { appendCustomBuildEvent } from "@/lib/custom-builds/events";
import {
  CustomBuildLeaseLostError,
  isCustomBuildLeaseLostError,
  throwIfCustomBuildLeaseLost,
} from "@/lib/custom-builds/lease";
import { decryptProviderKey, decryptSecretValue } from "@/lib/custom-builds/secrets";
import { redactSensitiveText, safeCustomBuildRetryReason } from "@/lib/custom-builds/sanitize";
import {
  assertCustomBuildStorageConfigured,
  downloadCustomBuildArtifactStream,
} from "@/lib/custom-builds/storage";
import { persistVoxelWorldArtifacts } from "@/lib/custom-builds/worldArtifacts";
import { prisma } from "@/lib/prisma";
import { buildGalleryPreviewSvg } from "@/lib/gallery/preview";
import { packVoxelBlocks, sortPackedVoxelBlocks, voxelBuildBlockCount } from "@/lib/voxel/packedBlocks";
import { createVoxelMeshFacts, encodeVoxelMeshFacts } from "@/lib/voxel/meshFacts";
import { validateOwnedVoxelBuild, validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";
import { summarizeVoxelWorldRegions } from "@/lib/voxel/worldRegions";
import { generationProviderSignal } from "@/lib/generation-worker/providerSignal";

type GenerateJobPayload = {
  stubBuild?: unknown;
  openaiResponseId?: string;
};

type GenerateVoxelBuildModel = NonNullable<GenerateVoxelBuildParams["model"]>;

type GeneratedBuildResult = {
  build: VoxelBuild;
  warnings: string[];
  blockCount: number;
  generationTimeMs: number | null;
  completedAt?: Date;
  sourceArtifactSha256?: string;
  canonicalArtifact?: { sourceSha256: string; byteSize: number | bigint; storedByteSize: number | bigint };
};

export type ImportedCustomBuildResult = Required<Pick<
  GeneratedBuildResult,
  "build" | "warnings" | "blockCount" | "generationTimeMs" | "completedAt" | "sourceArtifactSha256"
>>;

const CUSTOM_BUILD_MODEL_MAX_ATTEMPTS = 2;
const MAX_RECOVERED_RAW_RESPONSE_BYTES = 8 * 1024 * 1024;

export function customBuildProviderSignal(
  signal?: AbortSignal,
  timeoutMs?: number,
): AbortSignal {
  return generationProviderSignal(signal, timeoutMs);
}

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
  if (payload.openaiResponseId !== undefined &&
      (typeof payload.openaiResponseId !== "string" || !/^resp_[A-Za-z0-9_-]{1,200}$/.test(payload.openaiResponseId))) {
    throw new Error("Invalid saved OpenAI response id");
  }
  return payload as GenerateJobPayload;
}

function assertGridSize(value: number): GridSize {
  if (isGridSize(value)) return value;
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
  customConfig?: SavedGenerationRequestConfig,
): GenerateVoxelBuildModel {
  return {
    key: customBuild.modelKind === "catalog" && customBuild.modelKey ? customBuild.modelKey : customBuild.publicId,
    provider: customBuildProviderForGeneration(customBuild.modelProvider),
    modelId: customBuild.modelId,
    displayName: customBuild.modelDisplayName,
    openRouterModelId: customBuild.openRouterModelId ?? undefined,
    forceOpenRouter: customBuild.modelKind === "openrouter",
    baseUrl: customConfig?.baseUrl,
    customHeaders: customConfig?.headers,
    customBody: customConfig?.body,
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
  if (message.includes("heap_limit_exceeded")) {
    return { code: "heap_limit_exceeded", message: "This build exceeded the processing memory limit." };
  }
  if (message.includes("processing_capacity_exceeded")) {
    return { code: "processing_capacity_exceeded", message: "This build exceeds the current processing capacity." };
  }
  if (message.includes("openai_response_checkpoint_failed")) {
    return { code: "provider_checkpoint_failed", message: "The provider response could not be saved." };
  }
  if (isCustomBuildArtifactBookkeepingError(error)) {
    return { code: "artifact_bookkeeping_failed", message: "The saved generation could not be completed." };
  }
  if (isCustomBuildArtifactPersistenceError(error) || message.includes("custom_build_artifact_persistence_failed")) {
    return { code: "artifact_persistence_failed", message: "The generated result could not be saved." };
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
  if (isVoxelBuildResourceError(normalized)) return true;
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
  output: "objects" | "packed" = "objects",
): { build: VoxelBuild; warnings: string[]; blockCount: number } {
  const gridSize = assertGridSize(customBuild.gridSize);
  const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
  if (gridSize > 512) {
    const summarized = summarizeVoxelWorldRegions(build, {
      gridSize,
      palette: getPalette(palette),
    });
    if (!summarized.ok) {
      throw new Error(`Generated custom build is invalid: ${summarized.error}`);
    }
    return {
      build: summarized.value.build,
      warnings: summarized.value.warnings,
      blockCount: summarized.value.blockCount,
    };
  }
  const validated = (output === "packed" ? validateOwnedVoxelBuild : validateVoxelBuild)(build, {
    gridSize,
    palette: getPalette(palette),
    maxBlocks: MAX_BLOCKS_BY_GRID[gridSize],
    output,
  });
  if (!validated.ok) {
    throw new Error(`Generated custom build is invalid: ${validated.error}`);
  }
  return { ...validated.value, blockCount: voxelBuildBlockCount(validated.value.build) };
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
    processResponse?: ProcessVoxelBuildResponse;
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
      blockCount: validated.blockCount,
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
  const customConfig =
    secret.endpointCiphertext && secret.endpointIv && secret.endpointAuthTag
      ? deserializeSavedGenerationRequestConfig(
          decryptSecretValue(
            {
              ciphertext: secret.endpointCiphertext,
              iv: secret.endpointIv,
              authTag: secret.endpointAuthTag,
              keyVersion: secret.keyVersion,
            },
            customBuild.id,
          ),
        )
      : undefined;
  const gridSize = assertGridSize(customBuild.gridSize);
  const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
  const providerKeys = providerKeysForSecret(secret.provider, providerKey);
  const configuredSecrets = [
    providerKey,
    ...requestOverrideSecretValues(customConfig ?? {}),
  ];
  let providerAttempts = 0;
  const providerSignal = customBuildProviderSignal(opts.signal);

  throwIfCustomBuildLeaseLost(opts.signal);
  const result = await generateVoxelBuild(
    {
      model: customBuildModelForGeneration(customBuild, customConfig),
      prompt: customBuild.promptText,
      gridSize,
      palette,
      providerKeys,
      allowServerKeys: false,
      preferOpenRouter: customBuild.preferOpenRouter,
      reasoning: customBuild.reasoning ?? undefined,
      abortSignal: providerSignal,
      maxAttempts: CUSTOM_BUILD_MODEL_MAX_ATTEMPTS,
      onProviderRequest: (attempt) => {
        providerAttempts = Math.max(providerAttempts, attempt);
      },
      openaiResponseId: payload.openaiResponseId,
      onOpenAIResponseCreated: async (responseId) => {
        throwIfCustomBuildLeaseLost(opts.signal);
        const checkpoint = await prisma.customBuildJob.updateMany({
          where: { id: job.id, status: "running", lockedBy: job.lockedBy },
          data: { payload: { ...(job.payload as Prisma.InputJsonObject), openaiResponseId: responseId } },
        });
        if (checkpoint.count !== 1) throw new CustomBuildLeaseLostError();
      },
      onRawResponse: async (attempt, text) => {
        const bytes = new TextEncoder().encode(text);
        const sha256 = sha256Hex(bytes);
        await persistCustomBuildArtifact({
          customBuildId: customBuild.id,
          publicId: customBuild.publicId,
          kind: "raw_text_debug",
          bytes,
          sha256,
          sourceBuildSha256: sha256,
          exportStats: { attempt },
        });
        await prisma.customBuild.updateMany({
          where: { id: customBuild.id, removedAt: null, status: "running" },
          data: { currentStage: "finalizing" },
        });
      },
      onRetry: async (attempt, reason) => {
        const safeReason = safeCustomBuildRetryReason(reason, configuredSecrets);
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
      buildOutput: "packed",
      processResponse: opts.processResponse,
    },
  );

  throwIfCustomBuildLeaseLost(opts.signal);
  if (!result.ok) {
    throw new CustomBuildGenerationFailedError(
      redactSensitiveText(result.error, 1_000, configuredSecrets) ||
        "The model response could not be used.",
      Math.max(1, providerAttempts),
    );
  }
  return {
    build: result.build,
    warnings: result.warnings,
    blockCount: result.blockCount,
    generationTimeMs: payload.openaiResponseId ? null : result.generationTimeMs,
  };
}

function persistedWarnings(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value)
    ? value.filter((warning): warning is string => typeof warning === "string")
    : [];
}

async function recoverStoredRawBuild(
  customBuild: CustomBuild,
  opts: {
    signal?: AbortSignal;
    acquireBuildProcessing?: () => Promise<() => void>;
    processResponse?: ProcessVoxelBuildResponse;
  },
): Promise<GeneratedBuildResult | null> {
  const artifact = await prisma.customBuildArtifact.findFirst({
    where: { customBuildId: customBuild.id, kind: "raw_text_debug" },
    select: {
      bucket: true,
      path: true,
      encoding: true,
      sha256: true,
      sourceBuildSha256: true,
      storedByteSize: true,
      exportStats: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!artifact) return null;
  try {
    await opts.acquireBuildProcessing?.();
    throwIfCustomBuildLeaseLost(opts.signal);
    if (!artifact.sha256 || !artifact.sourceBuildSha256) {
      throw new Error("Stored raw response metadata is incomplete");
    }
    if (artifact.storedByteSize > MAX_RECOVERED_RAW_RESPONSE_BYTES) {
      throw new Error("Stored raw response exceeds the 8 MiB recovery limit");
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for await (const chunk of downloadCustomBuildArtifactStream({ ...artifact, signal: opts.signal })) {
      throwIfCustomBuildLeaseLost(opts.signal);
      byteLength += chunk.byteLength;
      if (byteLength > MAX_RECOVERED_RAW_RESPONSE_BYTES) {
        throw new Error("Stored raw response exceeds the 8 MiB recovery limit");
      }
      chunks.push(chunk);
    }
    const text = decodeAndVerifyCustomBuildArtifactText({
      bytes: Buffer.concat(chunks, byteLength),
      encoding: artifact.encoding,
      storedSha256: artifact.sha256,
      sourceSha256: artifact.sourceBuildSha256,
      maxOutputBytes: MAX_RECOVERED_RAW_RESPONSE_BYTES,
    });
    throwIfCustomBuildLeaseLost(opts.signal);
    const finalizing = await prisma.customBuild.updateMany({
      where: { id: customBuild.id, removedAt: null, status: "running" },
      data: { currentStage: "finalizing" },
    });
    if (finalizing.count !== 1) throw new CustomBuildLeaseLostError();
    const stats = artifact.exportStats;
    const attempt = stats && typeof stats === "object" && !Array.isArray(stats) &&
      typeof stats.attempt === "number" && Number.isInteger(stats.attempt) && stats.attempt > 0
      ? stats.attempt
      : 1;
    try {
      throwIfCustomBuildLeaseLost(opts.signal);
      const responseOptions = {
        gridSize: assertGridSize(customBuild.gridSize),
        palette: customBuild.palette === "advanced" ? "advanced" as const : "simple" as const,
        buildOutput: "packed" as const,
      };
      const result = opts.processResponse
        ? await opts.processResponse(text, responseOptions, opts.signal)
        : processVoxelBuildResponse(text, responseOptions);
      throwIfCustomBuildLeaseLost(opts.signal);
      if (!result.ok) throw new Error(result.error);
      return {
        build: result.build,
        warnings: Array.from(new Set([...persistedWarnings(customBuild.warnings), ...result.warnings])),
        blockCount: result.blockCount,
        generationTimeMs: customBuild.generationTimeMs,
        sourceArtifactSha256: artifact.sourceBuildSha256,
      };
    } catch (error) {
      throwIfCustomBuildLeaseLost(opts.signal);
      throw new CustomBuildGenerationFailedError(redactSensitiveText(error, 1_000), attempt);
    }
  } catch (error) {
    throwIfCustomBuildLeaseLost(opts.signal);
    if (isCustomBuildLeaseLostError(error) || error instanceof CustomBuildGenerationFailedError) throw error;
    throw new CustomBuildArtifactBookkeepingError(error);
  }
}

async function recoverStoredBuild(
  customBuild: CustomBuild,
  opts: {
    signal?: AbortSignal;
    acquireBuildProcessing?: () => Promise<() => void>;
    processResponse?: ProcessVoxelBuildResponse;
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
      byteSize: true,
      storedByteSize: true,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!artifact) return recoverStoredRawBuild(customBuild, opts);
  try {
    await opts.acquireBuildProcessing?.();
    throwIfCustomBuildLeaseLost(opts.signal);
    if (artifact.encoding !== "gzip" || !artifact.sourceBuildSha256) {
      throw new Error("Stored canonical artifact metadata is incomplete");
    }
    const gridSize = assertGridSize(customBuild.gridSize);
    const build = await readStoredBuildSource(artifact, {
      signal: opts.signal,
      maxBlocks: gridSize <= 512 ? MAX_BLOCKS_BY_GRID[gridSize] : undefined,
    });
    throwIfCustomBuildLeaseLost(opts.signal);
    const validated = validateGeneratedBuildForArtifacts(build, customBuild, "packed");
    if (artifact.blockCount != null && BigInt(artifact.blockCount) !== BigInt(validated.blockCount)) {
      throw new Error("Stored canonical block count does not match");
    }
    return {
      build: validated.build,
      warnings: Array.from(new Set([
        ...persistedWarnings(customBuild.warnings),
        ...validated.warnings,
      ])),
      blockCount: validated.blockCount,
      generationTimeMs: customBuild.generationTimeMs,
      canonicalArtifact: {
        sourceSha256: artifact.sourceBuildSha256,
        byteSize: artifact.byteSize,
        storedByteSize: artifact.storedByteSize,
      },
    };
  } catch (error) {
    throwIfCustomBuildLeaseLost(opts.signal);
    if (isCustomBuildLeaseLostError(error)) throw error;
    throw new CustomBuildArtifactBookkeepingError(error);
  }
}

export async function runCustomBuildGenerateJob(
  job: CustomBuildJob,
  opts: {
    signal?: AbortSignal;
    acquireBuildProcessing?: () => Promise<() => void>;
    processResponse?: ProcessVoxelBuildResponse;
    beforeSynchronousArtifactPackaging?: () => Promise<void> | void;
    importedBuild?: ImportedCustomBuildResult;
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
      currentStage: opts.importedBuild ? "finalizing" : "generating",
    },
  });
  if (started.count !== 1) throw new CustomBuildLeaseLostError();
  emitCustomBuildEvent(customBuild.id, "started", {
    stage: opts.importedBuild ? "finalizing" : "generating",
  });

  let artifactsPersisted = false;
  try {
    try {
      assertCustomBuildStorageConfigured();
    } catch (error) {
      throw new CustomBuildArtifactPersistenceError(error);
    }
    const recovered = opts.importedBuild ? null : await recoverStoredBuild(customBuild, opts);
    const generated: GeneratedBuildResult = opts.importedBuild ?? recovered ?? await generateBuild(customBuild, job, opts);
    if (recovered) {
      const finalizing = await prisma.customBuild.updateMany({
        where: { id: customBuild.id, removedAt: null, status: "running" },
        data: { currentStage: "finalizing" },
      });
      if (finalizing.count !== 1) throw new CustomBuildLeaseLostError();
      emitCustomBuildEvent(customBuild.id, "recovered", { stage: "finalizing" });
    }
    throwIfCustomBuildLeaseLost(opts.signal);
    await opts.beforeSynchronousArtifactPackaging?.();
    throwIfCustomBuildLeaseLost(opts.signal);
    const gridSize = assertGridSize(customBuild.gridSize);
    const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
    const useWorldArtifacts = gridSize > 512;
    const canonicalBuild = generated.build;
    if (!useWorldArtifacts && !generated.canonicalArtifact) {
      if (canonicalBuild.packed) sortPackedVoxelBlocks(canonicalBuild.packed);
      else canonicalBuild.blocks.sort(
        (a, b) => a.x - b.x || a.y - b.y || a.z - b.z || a.type.localeCompare(b.type),
      );
    }
    const canonicalBlockCount = useWorldArtifacts ? generated.blockCount : voxelBuildBlockCount(canonicalBuild);
    let sourceArtifact = generated.canonicalArtifact;
    if (!sourceArtifact) {
      const canonicalArtifact = useWorldArtifacts
        ? await writeVoxelBuildSourceArtifact(canonicalBuild)
        : await writeCanonicalBuildArtifact(canonicalBuild);
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
          sourceBuildSha256: canonicalArtifact.sourceSha256,
          blockCount: generated.blockCount,
          encoding: "gzip",
        });
        sourceArtifact = canonicalArtifact;
      } finally {
        await canonicalArtifact.cleanup();
      }
    }
    const buildByteSize = sourceArtifact.byteSize;
    const buildCompressedByteSize = sourceArtifact.storedByteSize;
    const fullSha = sourceArtifact.sourceSha256;
    artifactsPersisted = true;
    emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "build_json" });

    throwIfCustomBuildLeaseLost(opts.signal);
    let preview = buildCustomBuildPreview(canonicalBuild);
    if (useWorldArtifacts) {
      const worldArtifacts = await persistVoxelWorldArtifacts({
        customBuildId: customBuild.id,
        publicId: customBuild.publicId,
        sourceBuildSha256: fullSha,
        sourceBuild: canonicalBuild,
        consumeSource: true,
        gridSize,
        palette,
        previewTargetBlocks: getCustomBuildPreviewTargetBlocks(),
        persistArtifact: persistCustomBuildArtifact,
        throwIfCanceled: () => throwIfCustomBuildLeaseLost(opts.signal),
      });
      preview = worldArtifacts.previewBuild;
      emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "viewer_world" });
    }
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
    if (!useWorldArtifacts) {
      const viewerKind =
        canonicalBlockCount >= ARENA_MESH_FACTS_MIN_BLOCKS
          ? "viewer_mbf1"
          : "viewer_mbv4";
      const viewerBytes =
        viewerKind === "viewer_mbf1"
          ? encodeVoxelMeshFacts(createVoxelMeshFacts(canonicalBuild.packed ?? packVoxelBlocks(canonicalBuild.blocks)))
          : encodeBinaryArtifact(
              {
                buildId: customBuild.publicId,
                variant: "full",
                checksum: fullSha,
                serverValidated: true,
                version: canonicalBuild.version,
              },
              canonicalBuild.packed ?? canonicalBuild.blocks,
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
        blockCount: canonicalBlockCount,
        encoding: "gzip",
      });
      emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: viewerKind });
    }

    throwIfCustomBuildLeaseLost(opts.signal);
    const previewSvg = new TextEncoder().encode(buildGalleryPreviewSvg(useWorldArtifacts ? preview : canonicalBuild));
    await persistCustomBuildArtifact({
      customBuildId: customBuild.id,
      publicId: customBuild.publicId,
      kind: "preview_svg",
      bytes: previewSvg,
      sha256: sha256Hex(previewSvg),
      sourceBuildSha256: fullSha,
      blockCount: canonicalBlockCount,
    });
    emitCustomBuildEvent(customBuild.id, "artifact_ready", { kind: "preview_svg" });
    artifactsPersisted = true;

    throwIfCustomBuildLeaseLost(opts.signal);
    await prisma.$transaction(async (tx) => {
      await lockNotificationAccounts(tx, [customBuild.ownerId]);
      const stored = await tx.customBuildArtifact.aggregate({
        where: { customBuildId: customBuild.id },
        _sum: { storedByteSize: true },
      });
      const completed = await tx.customBuild.updateMany({
        where: { id: customBuild.id, removedAt: null, status: "running" },
        data: {
          status: "succeeded",
          currentStage: "complete",
          completedAt: generated.completedAt ?? new Date(),
          blockCount: generated.blockCount,
          generationTimeMs: generated.generationTimeMs,
          warnings: generated.warnings,
          metrics: {
            blockCount: generated.blockCount,
            generationTimeMs: generated.generationTimeMs,
            warnings: generated.warnings,
            ...(generated.sourceArtifactSha256
              ? { sourceArtifactSha256: generated.sourceArtifactSha256 }
              : {}),
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
      if (!opts.importedBuild) await enqueueGenerationNotification(tx, customBuild.id);
    });

    throwIfCustomBuildLeaseLost(opts.signal);
    throwIfCustomBuildLeaseLost(opts.signal);
    emitCustomBuildEvent(customBuild.id, "complete", { stage: "complete" });
    if (!opts.importedBuild) {
      recordGenerationSuccess({
        jobType: "worker",
        model: customBuild.modelKey || customBuild.modelDisplayName || customBuild.modelId,
        durationMs: generated.generationTimeMs ?? (Date.now() - (customBuild.startedAt?.getTime() ?? Date.now())),
      });
    }
  } catch (error) {
    if (isCustomBuildLeaseLostError(error)) throw error;
    throwIfCustomBuildLeaseLost(opts.signal);
    const infrastructureFailure = !(error instanceof CustomBuildGenerationFailedError) ||
      error.reason.includes("custom_build_artifact_persistence_failed");
    const retryFinalization = artifactsPersisted || (infrastructureFailure && Boolean(
      await prisma.customBuildArtifact.findFirst({
        where: { customBuildId: customBuild.id, kind: { in: ["build_json", "raw_text_debug"] } },
        select: { id: true },
      }),
    ));
    throwIfCustomBuildLeaseLost(opts.signal);
    const effectiveError =
      retryFinalization && !isCustomBuildArtifactBookkeepingError(error)
        ? new CustomBuildArtifactBookkeepingError(error)
        : error;
    const message = redactSensitiveText(effectiveError);
    if (!opts.importedBuild) {
      recordGenerationError({
        jobType: "worker",
        model: customBuild.modelKey || customBuild.modelDisplayName || customBuild.modelId,
        errorType: message,
      });
    }
    const manuallyRetryable =
      retryFinalization ||
      (effectiveError instanceof CustomBuildGenerationFailedError &&
        (!isTerminalCustomBuildGenerateError(message) || isVoxelBuildResourceError(message)));
    const terminal =
      (!retryFinalization && (isCustomBuildArtifactPersistenceError(effectiveError) ||
        isCustomBuildArtifactBookkeepingError(effectiveError) ||
        effectiveError instanceof CustomBuildGenerationFailedError ||
        isTerminalCustomBuildGenerateError(message))) ||
      job.attempts >= job.maxAttempts;
    if (terminal) {
      const failure = safeGenerateFailure(effectiveError, message);
      await prisma.$transaction(async (tx) => {
        await lockNotificationAccounts(tx, [customBuild.ownerId]);
        const failed = await tx.customBuild.updateMany({
          where: { id: customBuild.id, removedAt: null, status: "running" },
          data: {
            status: "failed",
            currentStage: "failed",
            completedAt: new Date(),
            errorCode: failure.code,
            errorMessage: failure.message,
            errorRetryable: manuallyRetryable,
            progress: effectiveError instanceof CustomBuildGenerationFailedError
              ? { attempt: effectiveError.attempt, reason: safeCustomBuildRetryReason(effectiveError.reason) }
              : Prisma.DbNull,
            objectsDeletedAt: null,
            deletionPendingAt: manuallyRetryable ? null : new Date(),
            deletionError: null,
          },
        });
        if (failed.count !== 1) throw new CustomBuildLeaseLostError();
        await tx.customBuildStatsDaily.upsert({
          where: { day: new Date(new Date().toISOString().slice(0, 10)) },
          create: { day: new Date(new Date().toISOString().slice(0, 10)), failed: 1 },
          update: { failed: { increment: 1 } },
        });
        await tx.customBuildSecret.deleteMany({ where: { customBuildId: customBuild.id } });
        if (!opts.importedBuild) await enqueueGenerationNotification(tx, customBuild.id);
      });
      emitCustomBuildEvent(customBuild.id, "failed", { code: failure.code });
      throw new Error(failure.code);
    } else {
      if (retryFinalization) await prisma.customBuildSecret.deleteMany({ where: { customBuildId: customBuild.id } });
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
