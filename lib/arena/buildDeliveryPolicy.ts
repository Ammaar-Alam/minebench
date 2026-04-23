import type { ArenaBuildDeliveryClass } from "@/lib/arena/types";

const MIB_BYTES = 1024 * 1024;
const DEFAULT_INLINE_MAX_BYTES = 6 * MIB_BYTES;
const DEFAULT_SNAPSHOT_MAX_BYTES = 15 * MIB_BYTES;
const DEFAULT_ARTIFACT_MIN_BYTES = DEFAULT_SNAPSHOT_MAX_BYTES + 1;
const DEFAULT_PREVIEW_TRIGGER_BYTES = 30 * MIB_BYTES;

const ARENA_INLINE_MAX_BYTES = readIntEnv("ARENA_INLINE_INITIAL_MAX_BYTES", DEFAULT_INLINE_MAX_BYTES);
const ARENA_SNAPSHOT_MAX_BYTES = readIntEnv("ARENA_SNAPSHOT_MAX_BYTES", DEFAULT_SNAPSHOT_MAX_BYTES);
const ARENA_PREVIEW_TRIGGER_BYTES = readIntEnv(
  "ARENA_PREVIEW_TRIGGER_BYTES",
  DEFAULT_PREVIEW_TRIGGER_BYTES,
);
const ARENA_ARTIFACT_MIN_BYTES = readIntEnv("ARENA_ARTIFACT_MIN_BYTES", DEFAULT_ARTIFACT_MIN_BYTES);

type ByteMeta = {
  voxelByteSize?: number | null;
  voxelCompressedByteSize?: number | null;
  blockCount?: number | null;
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeEstimatedBytes(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function estimateArenaBuildBytes(meta: ByteMeta): number | null {
  const direct = normalizeEstimatedBytes(meta.voxelByteSize);
  const compressed = normalizeEstimatedBytes(meta.voxelCompressedByteSize);
  const fromCompressed = compressed ? Math.floor(compressed * 3.4) : null;
  const blockCount =
    typeof meta.blockCount === "number" && Number.isFinite(meta.blockCount) && meta.blockCount > 0
      ? Math.floor(meta.blockCount)
      : null;
  // A block-count-derived floor avoids badly underestimating primitive-heavy builds where
  // a compact source JSON expands into a huge hydrated scene.
  const fromBlockCount = blockCount ? Math.floor(blockCount * 34) : null;

  return Math.max(direct ?? 0, fromCompressed ?? 0, fromBlockCount ?? 0) || null;
}

export function classifyArenaBuildDelivery(estimatedBytes: number | null): ArenaBuildDeliveryClass {
  if (estimatedBytes == null) return "stream-live";
  if (estimatedBytes <= ARENA_INLINE_MAX_BYTES) return "inline";
  if (estimatedBytes <= ARENA_SNAPSHOT_MAX_BYTES) return "snapshot";
  if (estimatedBytes < ARENA_ARTIFACT_MIN_BYTES) return "stream-live";
  return "stream-artifact";
}

export function shouldPreferPreviewVariant(estimatedBytes: number | null): boolean {
  return estimatedBytes != null && estimatedBytes >= ARENA_PREVIEW_TRIGGER_BYTES;
}

export function isArtifactEligibleBuild(estimatedBytes: number | null): boolean {
  return estimatedBytes != null && estimatedBytes >= ARENA_ARTIFACT_MIN_BYTES;
}

export function getArenaArtifactMinBytes(): number {
  return ARENA_ARTIFACT_MIN_BYTES;
}
