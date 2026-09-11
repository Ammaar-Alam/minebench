import { isGridSize, type GridSize } from "@/lib/ai/limits";
import { encodeVoxelPositionKey } from "@/lib/voxel/coordinateKeys";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPalette } from "@/lib/blocks/palettes";
import {
  classifyArenaBuildDelivery,
  estimateArenaBuildBytes,
  shouldPreferPreviewVariant,
} from "@/lib/arena/buildDeliveryPolicy";
import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";
import { filterRenderableVoxelBuild } from "@/lib/voxel/renderVisibility";
import { SpatialBlockTable } from "@/lib/voxel/ambientOcclusion";
import {
  voxelBuildBlockAt,
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";
import { resolveBuildPayload } from "@/lib/storage/buildPayload";
import { normalizeArenaBuildChecksum } from "@/lib/arena/buildChecksum";

export type ArenaBuildVariant = "preview" | "full";

export type ArenaBuildRef = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
};

export type ArenaBuildLoadHints = {
  initialVariant: ArenaBuildVariant;
  initialDeliveryClass: "inline" | "snapshot" | "stream-live" | "stream-artifact";
  deliveryClass: "inline" | "snapshot" | "stream-live" | "stream-artifact";
  fullBlockCount: number;
  previewBlockCount: number;
  previewStride: number;
  initialEstimatedBytes: number | null;
  fullEstimatedBytes: number | null;
};

export type ArenaBuildSource = {
  id: string;
  privateAccessOnly?: boolean;
  gridSize: number;
  palette: string;
  blockCount: number;
  voxelByteSize: number | null;
  voxelCompressedByteSize: number | null;
  voxelSha256: string | null;
  voxelData: unknown | null;
  voxelStorageBucket: string | null;
  voxelStoragePath: string | null;
  voxelStorageEncoding: string | null;
  arenaBuildHints?: unknown | null;
};

// Payload overwrites clear derived state until artifact preparation succeeds
export const ARENA_BUILD_DERIVED_METADATA_RESET = {
  arenaBuildHints: Prisma.DbNull,
} as const;

type ArenaBuildPayloadIdentitySource = Pick<
  ArenaBuildSource,
  | "id"
  | "gridSize"
  | "palette"
  | "blockCount"
  | "voxelByteSize"
  | "voxelCompressedByteSize"
  | "voxelSha256"
  | "voxelStorageBucket"
  | "voxelStoragePath"
  | "voxelStorageEncoding"
>;

// Checksums may be absent, so storage and size metadata remain part of identity
export function getArenaBuildPayloadIdentity(source: ArenaBuildPayloadIdentitySource) {
  if (normalizeArenaBuildChecksum(source.voxelSha256)) {
    return { id: source.id, voxelSha256: source.voxelSha256 };
  }

  return {
    id: source.id,
    gridSize: source.gridSize,
    palette: source.palette,
    blockCount: source.blockCount,
    voxelByteSize: source.voxelByteSize,
    voxelCompressedByteSize: source.voxelCompressedByteSize,
    voxelSha256: source.voxelSha256,
    voxelStorageBucket: source.voxelStorageBucket,
    voxelStoragePath: source.voxelStoragePath,
    voxelStorageEncoding: source.voxelStorageEncoding,
  };
}

export type ArenaBuildPayloadIdentity = ReturnType<typeof getArenaBuildPayloadIdentity>;

export type PreparedArenaBuild = {
  buildId: string;
  payloadIdentity: ArenaBuildPayloadIdentity;
  checksum: string | null;
  fullBuild: RenderableVoxelBuild;
  previewBuild: RenderableVoxelBuild;
  hints: ArenaBuildLoadHints;
  buildRef: ArenaBuildRef;
  previewRef: ArenaBuildRef;
};

type CachedArtifact = {
  prepared: PreparedArenaBuild;
  byteWeight: number;
  touchedAt: number;
};

type ParsedArenaBuild = {
  build: RenderableVoxelBuild;
  payloadEstimatedBytes: number | null;
};

type PrepareArenaBuildOptions = {
  signal?: AbortSignal;
};

const ARENA_ARTIFACTS_ENABLED = readBoolEnv("ARENA_ARTIFACTS_ENABLED", true);
const ARENA_PREVIEW_STAGE_ENABLED = readBoolEnv("ARENA_PREVIEW_STAGE_ENABLED", true);
const PREVIEW_TARGET_BLOCKS = readIntEnv("ARENA_PREVIEW_TARGET_BLOCKS", 3_000);
const MEMORY_CACHE_MAX_ENTRIES = readIntEnv("ARENA_ARTIFACT_CACHE_MAX_ENTRIES", 128);
const MEMORY_CACHE_MAX_WEIGHT = readIntEnv("ARENA_ARTIFACT_CACHE_MAX_WEIGHT", 600_000_000);

const artifactCache = new Map<string, CachedArtifact>();
const inflight = new Map<string, Promise<PreparedArenaBuild>>();

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getArenaPreviewTargetBlocks(): number {
  return PREVIEW_TARGET_BLOCKS;
}

function normalizePalette(value: string): "simple" | "advanced" {
  return value === "advanced" ? "advanced" : "simple";
}

function normalizeGridSize(value: number): GridSize {
  if (isGridSize(value)) return value;
  return 256;
}

function normalizeStoredChecksum(source: ArenaBuildSource): string | null {
  return normalizeArenaBuildChecksum(source.voxelSha256);
}

function buildCacheKey(source: ArenaBuildSource, checksum: string): string {
  return `${source.id}:${checksum}`;
}

function buildCacheKeyFromParts(buildId: string, checksum: string): string {
  return `${buildId}:${checksum}`;
}

function normalizeBlockCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function shouldPreferPreview(fullEstimatedBytes: number | null): boolean {
  return ARENA_PREVIEW_STAGE_ENABLED && shouldPreferPreviewVariant(fullEstimatedBytes);
}

function parseArenaBuildVariant(value: unknown): ArenaBuildVariant | null {
  return value === "preview" || value === "full" ? value : null;
}

function parseArenaBuildDeliveryClass(
  value: unknown,
): ArenaBuildLoadHints["deliveryClass"] | null {
  return value === "inline" ||
    value === "snapshot" ||
    value === "stream-live" ||
    value === "stream-artifact"
    ? value
    : null;
}

function parseNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function parseNullableEstimatedBytes(value: unknown): number | null {
  return value == null ? null : parseNonNegativeInt(value);
}

export function parsePersistedArenaBuildLoadHints(value: unknown): ArenaBuildLoadHints | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const initialVariant = parseArenaBuildVariant(candidate.initialVariant);
  const deliveryClass = parseArenaBuildDeliveryClass(candidate.deliveryClass);
  const initialDeliveryClass =
    parseArenaBuildDeliveryClass(candidate.initialDeliveryClass) ?? deliveryClass;
  const fullBlockCount = parseNonNegativeInt(candidate.fullBlockCount);
  const previewBlockCount = parseNonNegativeInt(candidate.previewBlockCount);
  const previewStride = parseNonNegativeInt(candidate.previewStride);
  const fullEstimatedBytes = parseNullableEstimatedBytes(candidate.fullEstimatedBytes);
  const initialEstimatedBytes =
    parseNullableEstimatedBytes(candidate.initialEstimatedBytes) ?? fullEstimatedBytes;

  if (
    !initialVariant ||
    !deliveryClass ||
    !initialDeliveryClass ||
    fullBlockCount == null ||
    previewBlockCount == null ||
    previewStride == null
  ) {
    return null;
  }

  return {
    initialVariant,
    initialDeliveryClass: classifyArenaBuildDelivery(initialEstimatedBytes),
    deliveryClass: classifyArenaBuildDelivery(fullEstimatedBytes),
    fullBlockCount,
    previewBlockCount,
    previewStride,
    initialEstimatedBytes,
    fullEstimatedBytes,
  };
}

export function parsePersistedArenaBuildMetadata(row: {
  voxelSha256: unknown;
  arenaBuildHints: unknown;
}): { checksum: string | null; loadHints: ArenaBuildLoadHints | null; complete: boolean } {
  const checksum = normalizeArenaBuildChecksum(row.voxelSha256);
  const loadHints = parsePersistedArenaBuildLoadHints(row.arenaBuildHints);
  return { checksum, loadHints, complete: checksum != null && loadHints != null };
}

export function serializeArenaBuildLoadHints(hints: ArenaBuildLoadHints): Record<string, unknown> {
  return {
    initialVariant: hints.initialVariant,
    initialDeliveryClass: hints.initialDeliveryClass,
    deliveryClass: hints.deliveryClass,
    fullBlockCount: hints.fullBlockCount,
    previewBlockCount: hints.previewBlockCount,
    previewStride: hints.previewStride,
    initialEstimatedBytes: hints.initialEstimatedBytes,
    fullEstimatedBytes: hints.fullEstimatedBytes,
  };
}

export function getPreparedArenaBuildCoreMetadataUpdate(
  prepared: PreparedArenaBuild,
): Record<string, unknown> {
  // identity and hints only; snapshot payloads live in storage artifacts
  return {
    voxelSha256: prepared.checksum,
    arenaBuildHints: serializeArenaBuildLoadHints(prepared.hints),
  };
}

function estimatePayloadBytes(payload: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(payload));
  } catch {
    return null;
  }
}

function shouldEstimatePayloadBytes(source: ArenaBuildSource): boolean {
  return (
    estimateArenaBuildBytes({
      blockCount: source.blockCount,
      voxelByteSize: source.voxelByteSize,
      voxelCompressedByteSize: source.voxelCompressedByteSize,
    }) == null
  );
}

export function deriveArenaBuildLoadHints(
  source: Pick<ArenaBuildSource, "blockCount" | "voxelByteSize" | "voxelCompressedByteSize"> & {
    arenaBuildHints?: unknown | null;
  },
): ArenaBuildLoadHints {
  const persisted = parsePersistedArenaBuildLoadHints(source.arenaBuildHints);
  if (persisted) return persisted;

  const fullBlockCount = normalizeBlockCount(source.blockCount);
  const previewBlockCount = Math.min(fullBlockCount, PREVIEW_TARGET_BLOCKS);
  const previewEstimatedBytes = estimateArenaBuildBytes({ blockCount: previewBlockCount });
  const fullEstimatedBytes = estimateArenaBuildBytes({
    blockCount: fullBlockCount,
    voxelByteSize: source.voxelByteSize,
    voxelCompressedByteSize: source.voxelCompressedByteSize,
  });
  const deliveryClass = classifyArenaBuildDelivery(fullEstimatedBytes);
  // Only select "preview" when it would actually reduce payload. If the build is already smaller than the
  // preview target, "preview" would be identical to "full" and would add UX friction (extra hydration pass).
  const initialVariant: ArenaBuildVariant =
    shouldPreferPreview(fullEstimatedBytes) && previewBlockCount < fullBlockCount ? "preview" : "full";
  const initialEstimatedBytes =
    initialVariant === "preview" ? previewEstimatedBytes : fullEstimatedBytes;
  return {
    initialVariant,
    initialDeliveryClass: classifyArenaBuildDelivery(initialEstimatedBytes),
    deliveryClass,
    fullBlockCount,
    previewBlockCount,
    previewStride: 1,
    initialEstimatedBytes,
    fullEstimatedBytes,
  };
}

const NEIGHBOR_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function hashBlock(block: VoxelBlock): number {
  let h = (block.x * 73856093) ^ (block.y * 19349663) ^ (block.z * 83492791);
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function buildBlockAt(build: RenderableVoxelBuild, index: number): VoxelBlock {
  const block = voxelBuildBlockAt(build, index);
  if (!block) throw new Error(`Missing voxel block at index ${index}`);
  return block;
}

function hashBuildBlockAt(build: RenderableVoxelBuild, index: number): number {
  return hashBlock(buildBlockAt(build, index));
}

function extractSurfaceBlockIndices(build: RenderableVoxelBuild): number[] {
  const blockCount = voxelBuildBlockCount(build);
  const occupied = new SpatialBlockTable(blockCount);
  for (let index = 0; index < blockCount; index += 1) {
    const block = buildBlockAt(build, index);
    occupied.set(block.x, block.y, block.z, 0);
  }

  const surface: number[] = [];
  for (let index = 0; index < blockCount; index += 1) {
    const block = buildBlockAt(build, index);
    let exposed = false;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      if (occupied.get(block.x + dx, block.y + dy, block.z + dz) === -1) {
        exposed = true;
        break;
      }
    }
    if (exposed) surface.push(index);
  }
  return surface;
}

function deterministicSampleBlockIndices(
  build: RenderableVoxelBuild,
  indices: number[],
  targetBlockCount: number,
): number[] {
  if (indices.length <= targetBlockCount) return indices;
  if (targetBlockCount <= 0) return [];

  // stable sampling avoids preview churn between requests
  const keepRatio = targetBlockCount / indices.length;
  const sampled = indices.filter(
    (index) => hashBuildBlockAt(build, index) / 0xffffffff <= keepRatio,
  );
  if (sampled.length >= targetBlockCount) return sampled.slice(0, targetBlockCount);

  const sampledIndices = new Set(sampled);
  const remainder = targetBlockCount - sampled.length;
  const stride = Math.max(1, Math.floor(indices.length / Math.max(1, remainder)));
  for (let i = 0; i < indices.length && sampled.length < targetBlockCount; i += stride) {
    const index = indices[i]!;
    if (sampledIndices.has(index)) continue;
    sampled.push(index);
    sampledIndices.add(index);
  }

  return sampled.slice(0, targetBlockCount);
}

function buildPreviewSubset(
  build: RenderableVoxelBuild,
  indices: readonly number[],
): VoxelBuild {
  const blocks: VoxelBlock[] = [];
  for (const index of indices) blocks.push(buildBlockAt(build, index));
  return { version: "1.0", blocks };
}

function buildPreviewBuild(
  fullBuild: RenderableVoxelBuild,
  targetBlockCount: number,
): { build: RenderableVoxelBuild; stride: number } {
  const sourceBlockCount = voxelBuildBlockCount(fullBuild);
  if (sourceBlockCount <= targetBlockCount) {
    return { build: fullBuild, stride: 1 };
  }

  const surfaceIndices = extractSurfaceBlockIndices(fullBuild);
  const previewIndices =
    surfaceIndices.length > targetBlockCount
      ? deterministicSampleBlockIndices(fullBuild, surfaceIndices, targetBlockCount)
      : surfaceIndices;

  return {
    build: buildPreviewSubset(fullBuild, previewIndices),
    stride: 1,
  };
}

function computeBuildChecksum(fullBuild: RenderableVoxelBuild): string {
  const blockCount = voxelBuildBlockCount(fullBuild);
  const hash = createHash("sha256");
  hash.update(`v=${fullBuild.version};n=${blockCount};`);
  for (let index = 0; index < blockCount; index += 1) {
    const block = buildBlockAt(fullBuild, index);
    hash.update(`${block.x},${block.y},${block.z},${block.type};`);
  }
  return hash.digest("hex");
}

function createPrepared(
  source: ArenaBuildSource,
  fullBuild: RenderableVoxelBuild,
  payloadEstimatedBytes: number | null,
  checksumOverride?: string | null,
): PreparedArenaBuild {
  const renderBuild = filterRenderableVoxelBuild(fullBuild);
  const hintsFromMetadata = deriveArenaBuildLoadHints({
    blockCount: voxelBuildBlockCount(renderBuild),
    voxelByteSize: source.voxelByteSize,
    voxelCompressedByteSize: source.voxelCompressedByteSize,
  });
  const fullEstimatedBytes = hintsFromMetadata.fullEstimatedBytes ?? payloadEstimatedBytes;
  const deliveryClass = classifyArenaBuildDelivery(fullEstimatedBytes);
  const preferPreview = shouldPreferPreview(fullEstimatedBytes);
  const preview = preferPreview
    ? buildPreviewBuild(renderBuild, PREVIEW_TARGET_BLOCKS)
    : { build: renderBuild, stride: 1 };
  const initialVariant: ArenaBuildVariant =
    preferPreview && voxelBuildBlockCount(preview.build) < voxelBuildBlockCount(renderBuild)
      ? "preview"
      : "full";
  const previewEstimatedBytes = estimateArenaBuildBytes({
    blockCount: voxelBuildBlockCount(preview.build),
  });
  const initialEstimatedBytes =
    initialVariant === "preview" ? previewEstimatedBytes : fullEstimatedBytes;
  const checksum =
    checksumOverride ?? normalizeStoredChecksum(source) ?? computeBuildChecksum(renderBuild);

  return {
    buildId: source.id,
    payloadIdentity: getArenaBuildPayloadIdentity(source),
    checksum,
    fullBuild: renderBuild,
    previewBuild: preview.build,
    hints: {
      ...hintsFromMetadata,
      initialDeliveryClass: classifyArenaBuildDelivery(initialEstimatedBytes),
      fullEstimatedBytes,
      deliveryClass,
      initialVariant,
      previewBlockCount: voxelBuildBlockCount(preview.build),
      previewStride: preview.stride,
      initialEstimatedBytes,
    },
    buildRef: {
      buildId: source.id,
      variant: "full",
      checksum,
    },
    previewRef: {
      buildId: source.id,
      variant: "preview",
      checksum,
    },
  };
}

export function prepareArenaBuildFromBuild(
  source: ArenaBuildSource,
  fullBuild: RenderableVoxelBuild,
  opts?: { payloadEstimatedBytes?: number | null; checksum?: string | null },
): PreparedArenaBuild {
  return createPrepared(
    source,
    fullBuild,
    opts?.payloadEstimatedBytes ?? null,
    opts?.checksum ?? normalizeStoredChecksum(source),
  );
}

function pruneCache() {
  if (artifactCache.size === 0) return;

  // cache weight is an estimate because full builds stay shared in memory
  let totalWeight = 0;
  for (const entry of artifactCache.values()) {
    totalWeight += entry.byteWeight;
  }

  if (artifactCache.size <= MEMORY_CACHE_MAX_ENTRIES && totalWeight <= MEMORY_CACHE_MAX_WEIGHT) {
    return;
  }

  const ordered = Array.from(artifactCache.entries()).sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [key, entry] of ordered) {
    if (artifactCache.size <= MEMORY_CACHE_MAX_ENTRIES && totalWeight <= MEMORY_CACHE_MAX_WEIGHT) {
      break;
    }
    artifactCache.delete(key);
    totalWeight -= entry.byteWeight;
  }
}

function estimateCacheWeight(prepared: PreparedArenaBuild): number {
  const full = prepared.hints.fullEstimatedBytes ?? prepared.hints.fullBlockCount * 34;
  const preview = prepared.hints.previewBlockCount * 34;
  return Math.max(1_024, Math.floor(full * 0.2 + preview));
}

function getCachedPrepared(cacheKey: string): PreparedArenaBuild | null {
  const cached = artifactCache.get(cacheKey);
  if (!cached) return null;
  cached.touchedAt = Date.now();
  return cached.prepared;
}

export function getCachedPreparedArenaBuild(
  buildId: string,
  checksum: string | null | undefined,
): PreparedArenaBuild | null {
  const normalizedChecksum = checksum?.trim();
  if (!normalizedChecksum) return null;
  return getCachedPrepared(buildCacheKeyFromParts(buildId, normalizedChecksum));
}

function setCachedPrepared(cacheKey: string, prepared: PreparedArenaBuild): void {
  artifactCache.set(cacheKey, {
    prepared,
    byteWeight: estimateCacheWeight(prepared),
    touchedAt: Date.now(),
  });
  pruneCache();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

async function awaitPreparedWithCallerAbort(
  promise: Promise<PreparedArenaBuild>,
  signal: AbortSignal | undefined,
): Promise<PreparedArenaBuild> {
  if (!signal) return promise;
  throwIfAborted(signal);

  let cleanup: () => void = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    cleanup = () => signal.removeEventListener("abort", abort);
  });

  try {
    // caller aborts should not cancel shared parse work
    return await Promise.race([promise, abortPromise]);
  } finally {
    cleanup();
  }
}

async function parseAndValidateBuild(
  source: ArenaBuildSource,
  opts?: PrepareArenaBuildOptions,
): Promise<ParsedArenaBuild> {
  throwIfAborted(opts?.signal);
  const payload = await resolveBuildPayload(source, { signal: opts?.signal });
  throwIfAborted(opts?.signal);
  const payloadEstimatedBytes = shouldEstimatePayloadBytes(source)
    ? estimatePayloadBytes(payload)
    : null;

  const validated = validateVoxelBuild(payload, {
    gridSize: normalizeGridSize(source.gridSize),
    palette: getPalette(normalizePalette(source.palette)),
    // Arena path intentionally avoids hard max-block enforcement.
    maxBlocks: Number.MAX_SAFE_INTEGER,
  });

  if (validated.ok) {
    throwIfAborted(opts?.signal);
    return { build: validated.value.build, payloadEstimatedBytes };
  }

  const parsed = parseVoxelBuildSpec(payload);
  if (!parsed.ok) {
    throw new Error(`Build payload is invalid: ${parsed.error}`);
  }
  throwIfAborted(opts?.signal);
  return { build: parsed.value, payloadEstimatedBytes };
}

export async function prepareArenaBuild(
  source: ArenaBuildSource,
  opts?: PrepareArenaBuildOptions,
): Promise<PreparedArenaBuild> {
  const storedChecksum = normalizeStoredChecksum(source);
  throwIfAborted(opts?.signal);

  if (!ARENA_ARTIFACTS_ENABLED) {
    // debug path keeps behavior simple when artifact prep is disabled
    const parsed = await parseAndValidateBuild(source, opts);
    const prepared = createPrepared(source, parsed.build, parsed.payloadEstimatedBytes, storedChecksum);
    prepared.hints.initialVariant = "full";
    return prepared;
  }

  // Private payloads must remain tied to a live database ownership check, and
  // checksumless payloads cannot safely reuse entries after in-place writes.
  if (!storedChecksum || source.privateAccessOnly) {
    const parsed = await parseAndValidateBuild(source, opts);
    return createPrepared(source, parsed.build, parsed.payloadEstimatedBytes, storedChecksum);
  }

  const cacheKey = buildCacheKey(source, storedChecksum);
  const cached = getCachedPrepared(cacheKey);
  if (cached) return cached;

  const existing = inflight.get(cacheKey);
  // concurrent requests should share one parse and validation pass
  if (existing) return awaitPreparedWithCallerAbort(existing, opts?.signal);

  const promise = (async () => {
    const parsed = await parseAndValidateBuild(source);
    const prepared = createPrepared(source, parsed.build, parsed.payloadEstimatedBytes, storedChecksum);
    setCachedPrepared(cacheKey, prepared);
    return prepared;
  })();

  inflight.set(cacheKey, promise);
  promise.then(
    () => {
      if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
    },
    () => {
      if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
    },
  );
  return awaitPreparedWithCallerAbort(promise, opts?.signal);
}

export function pickInitialBuild(prepared: PreparedArenaBuild): RenderableVoxelBuild {
  return prepared.hints.initialVariant === "preview" ? prepared.previewBuild : prepared.fullBuild;
}

export function pickBuildVariant(
  prepared: PreparedArenaBuild,
  variant: ArenaBuildVariant,
): RenderableVoxelBuild {
  return variant === "preview" ? prepared.previewBuild : prepared.fullBuild;
}
