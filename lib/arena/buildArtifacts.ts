import { createHash } from "node:crypto";
import { getPalette } from "@/lib/blocks/palettes";
import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";
import { resolveBuildPayload } from "@/lib/storage/buildPayload";

export type ArenaBuildVariant = "preview" | "full";

export type ArenaBuildRef = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
};

export type ArenaBuildLoadHints = {
  initialVariant: ArenaBuildVariant;
  fullBlockCount: number;
  previewBlockCount: number;
  previewStride: number;
  fullEstimatedBytes: number | null;
};

export type ArenaBuildSource = {
  id: string;
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
};

export type PreparedArenaBuild = {
  buildId: string;
  checksum: string | null;
  fullBuild: VoxelBuild;
  previewBuild: VoxelBuild;
  hints: ArenaBuildLoadHints;
  buildRef: ArenaBuildRef;
  previewRef: ArenaBuildRef;
};

type CachedArtifact = {
  prepared: PreparedArenaBuild;
  byteWeight: number;
  touchedAt: number;
};

const ARENA_ARTIFACTS_ENABLED = readBoolEnv("ARENA_ARTIFACTS_ENABLED", true);
const ARENA_PREVIEW_STAGE_ENABLED = readBoolEnv("ARENA_PREVIEW_STAGE_ENABLED", true);
const PREVIEW_TARGET_BLOCKS = readIntEnv("ARENA_PREVIEW_TARGET_BLOCKS", 900_000);
const PREVIEW_TRIGGER_BYTES = readIntEnv("ARENA_PREVIEW_TRIGGER_BYTES", 50 * 1024 * 1024);
const MEMORY_CACHE_MAX_ENTRIES = readIntEnv("ARENA_ARTIFACT_CACHE_MAX_ENTRIES", 24);
const MEMORY_CACHE_MAX_WEIGHT = readIntEnv("ARENA_ARTIFACT_CACHE_MAX_WEIGHT", 180_000_000);

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

function normalizePalette(value: string): "simple" | "advanced" {
  return value === "advanced" ? "advanced" : "simple";
}

function normalizeGridSize(value: number): 64 | 256 | 512 {
  if (value === 64 || value === 256 || value === 512) return value;
  return 256;
}

function normalizeStoredChecksum(source: ArenaBuildSource): string | null {
  const value = source.voxelSha256?.trim();
  return value ? value : null;
}

function buildCacheKey(source: ArenaBuildSource, checksum: string): string {
  return `${source.id}:${checksum}`;
}

function estimateJsonBytes(source: ArenaBuildSource, fullBlockCount: number): number | null {
  const direct = source.voxelByteSize;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }
  const compressed = source.voxelCompressedByteSize;
  if (typeof compressed === "number" && Number.isFinite(compressed) && compressed > 0) {
    return Math.floor(compressed * 3.4);
  }
  if (Number.isFinite(fullBlockCount) && fullBlockCount > 0) {
    // Typical per-block JSON footprint with commas/keys in this schema.
    return Math.floor(fullBlockCount * 34);
  }
  return null;
}

const NEIGHBOR_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function encodePosition(x: number, y: number, z: number): number {
  return (x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20);
}

function hashBlock(block: VoxelBlock): number {
  let h = (block.x * 73856093) ^ (block.y * 19349663) ^ (block.z * 83492791);
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function extractSurfaceBlocks(blocks: VoxelBlock[]): VoxelBlock[] {
  const occupied = new Set<number>();
  for (const block of blocks) {
    occupied.add(encodePosition(block.x, block.y, block.z));
  }

  const surface: VoxelBlock[] = [];
  for (const block of blocks) {
    let exposed = false;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const neighborKey = encodePosition(block.x + dx, block.y + dy, block.z + dz);
      if (!occupied.has(neighborKey)) {
        exposed = true;
        break;
      }
    }

    if (exposed) {
      surface.push(block);
    }
  }

  return surface;
}

function deterministicSampleBlocks(blocks: VoxelBlock[], targetBlockCount: number): VoxelBlock[] {
  if (blocks.length <= targetBlockCount) return blocks;
  if (targetBlockCount <= 0) return [];

  const keepRatio = targetBlockCount / blocks.length;
  const sampled = blocks.filter((block) => hashBlock(block) / 0xffffffff <= keepRatio);
  if (sampled.length >= targetBlockCount) {
    return sampled.slice(0, targetBlockCount);
  }

  const sampledKeys = new Set(sampled.map((block) => encodePosition(block.x, block.y, block.z)));
  const remainder = targetBlockCount - sampled.length;
  const stride = Math.max(1, Math.floor(blocks.length / Math.max(1, remainder)));
  for (let i = 0; i < blocks.length && sampled.length < targetBlockCount; i += stride) {
    const block = blocks[i];
    if (!block) continue;
    const key = encodePosition(block.x, block.y, block.z);
    if (sampledKeys.has(key)) continue;
    sampled.push(block);
    sampledKeys.add(key);
  }

  return sampled.slice(0, targetBlockCount);
}

function buildPreviewBuild(fullBuild: VoxelBuild, targetBlockCount: number): { build: VoxelBuild; stride: number } {
  const sourceBlocks = fullBuild.blocks;
  if (sourceBlocks.length <= targetBlockCount) {
    return { build: fullBuild, stride: 1 };
  }

  const surfaceBlocks = extractSurfaceBlocks(sourceBlocks);
  const previewBlocks =
    surfaceBlocks.length > targetBlockCount
      ? deterministicSampleBlocks(surfaceBlocks, targetBlockCount)
      : surfaceBlocks;

  return {
    build: {
      version: "1.0",
      blocks: previewBlocks,
    },
    stride: 1,
  };
}

function computeBuildChecksum(fullBuild: VoxelBuild): string {
  const hash = createHash("sha256");
  hash.update(`v=${fullBuild.version};n=${fullBuild.blocks.length};`);
  for (const block of fullBuild.blocks) {
    hash.update(`${block.x},${block.y},${block.z},${block.type};`);
  }
  return hash.digest("hex");
}

function createPrepared(
  source: ArenaBuildSource,
  fullBuild: VoxelBuild,
  checksumOverride?: string | null,
): PreparedArenaBuild {
  const fullEstimatedBytes = estimateJsonBytes(source, fullBuild.blocks.length);
  const preferPreview =
    ARENA_PREVIEW_STAGE_ENABLED &&
    typeof fullEstimatedBytes === "number" &&
    fullEstimatedBytes >= PREVIEW_TRIGGER_BYTES;

  const preview = buildPreviewBuild(fullBuild, PREVIEW_TARGET_BLOCKS);
  const checksum = checksumOverride ?? normalizeStoredChecksum(source) ?? computeBuildChecksum(fullBuild);
  const initialVariant: ArenaBuildVariant = preferPreview ? "preview" : "full";

  return {
    buildId: source.id,
    checksum,
    fullBuild,
    previewBuild: preview.build,
    hints: {
      initialVariant,
      fullBlockCount: fullBuild.blocks.length,
      previewBlockCount: preview.build.blocks.length,
      previewStride: preview.stride,
      fullEstimatedBytes,
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

function pruneCache() {
  if (artifactCache.size === 0) return;

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

function setCachedPrepared(cacheKey: string, prepared: PreparedArenaBuild): void {
  artifactCache.set(cacheKey, {
    prepared,
    byteWeight: estimateCacheWeight(prepared),
    touchedAt: Date.now(),
  });
  pruneCache();
}

async function parseAndValidateBuild(source: ArenaBuildSource): Promise<VoxelBuild> {
  const payload = await resolveBuildPayload(source);

  const validated = validateVoxelBuild(payload, {
    gridSize: normalizeGridSize(source.gridSize),
    palette: getPalette(normalizePalette(source.palette)),
    // Arena path intentionally avoids hard max-block enforcement.
    maxBlocks: Number.MAX_SAFE_INTEGER,
  });

  if (validated.ok) {
    return validated.value.build;
  }

  const parsed = parseVoxelBuildSpec(payload);
  if (!parsed.ok) {
    throw new Error(`Build payload is invalid: ${parsed.error}`);
  }
  return parsed.value;
}

export async function prepareArenaBuild(source: ArenaBuildSource): Promise<PreparedArenaBuild> {
  const storedChecksum = normalizeStoredChecksum(source);

  if (!ARENA_ARTIFACTS_ENABLED) {
    const fullBuild = await parseAndValidateBuild(source);
    const prepared = createPrepared(source, fullBuild, storedChecksum);
    prepared.hints.initialVariant = "full";
    return prepared;
  }

  // Without a durable content checksum we skip cache reuse to avoid stale artifacts after in-place overwrites.
  if (!storedChecksum) {
    const fullBuild = await parseAndValidateBuild(source);
    return createPrepared(source, fullBuild, null);
  }

  const cacheKey = buildCacheKey(source, storedChecksum);
  const cached = getCachedPrepared(cacheKey);
  if (cached) return cached;

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const fullBuild = await parseAndValidateBuild(source);
    const prepared = createPrepared(source, fullBuild, storedChecksum);
    setCachedPrepared(cacheKey, prepared);
    return prepared;
  })();

  inflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(cacheKey);
  }
}

export function pickInitialBuild(prepared: PreparedArenaBuild): VoxelBuild {
  return prepared.hints.initialVariant === "preview" ? prepared.previewBuild : prepared.fullBuild;
}

export function pickBuildVariant(
  prepared: PreparedArenaBuild,
  variant: ArenaBuildVariant,
): VoxelBuild {
  return variant === "preview" ? prepared.previewBuild : prepared.fullBuild;
}
