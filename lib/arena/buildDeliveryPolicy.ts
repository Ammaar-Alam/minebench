import type { ArenaBuildDeliveryClass } from "@/lib/arena/types";

const FIFTY_MB_BYTES = 50 * 1024 * 1024;

const ARENA_INLINE_MAX_BYTES = readIntEnv("ARENA_INLINE_INITIAL_MAX_BYTES", 8_000_000);
const ARENA_SNAPSHOT_MAX_BYTES = readIntEnv("ARENA_SNAPSHOT_MAX_BYTES", 20 * 1024 * 1024);
const ARENA_PREVIEW_TRIGGER_BYTES = readIntEnv(
  "ARENA_PREVIEW_TRIGGER_BYTES",
  FIFTY_MB_BYTES,
);
const ARENA_ARTIFACT_MIN_BYTES = readIntEnv("ARENA_ARTIFACT_MIN_BYTES", FIFTY_MB_BYTES);

type ByteMeta = {
  voxelByteSize?: number | null;
  voxelCompressedByteSize?: number | null;
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
  if (direct) return direct;

  const compressed = normalizeEstimatedBytes(meta.voxelCompressedByteSize);
  if (compressed) return Math.floor(compressed * 3.4);

  return null;
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
