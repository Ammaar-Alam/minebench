export type ArenaLatencyBucket =
  | "under-100ms"
  | "100-250ms"
  | "250-500ms"
  | "500-1000ms"
  | "1-2.5s"
  | "2.5-5s"
  | "5-10s"
  | "10s-plus";

export type ArenaBlockCountBucket =
  | "empty"
  | "under-8k"
  | "8k-50k"
  | "50k-150k"
  | "150k-300k"
  | "300k-1m"
  | "1m-plus"
  | "unknown";

export function roundMetricMs(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

export function getArenaLatencyBucket(durationMs: number): ArenaLatencyBucket {
  if (durationMs < 100) return "under-100ms";
  if (durationMs < 250) return "100-250ms";
  if (durationMs < 500) return "250-500ms";
  if (durationMs < 1_000) return "500-1000ms";
  if (durationMs < 2_500) return "1-2.5s";
  if (durationMs < 5_000) return "2.5-5s";
  if (durationMs < 10_000) return "5-10s";
  return "10s-plus";
}

export function getArenaBlockCountBucket(
  blockCount: number | null | undefined,
): ArenaBlockCountBucket {
  if (blockCount == null || !Number.isFinite(blockCount) || blockCount < 0) return "unknown";
  if (blockCount === 0) return "empty";
  if (blockCount < 8_000) return "under-8k";
  if (blockCount < 50_000) return "8k-50k";
  if (blockCount < 150_000) return "50k-150k";
  if (blockCount < 300_000) return "150k-300k";
  if (blockCount < 1_000_000) return "300k-1m";
  return "1m-plus";
}
