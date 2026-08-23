import type { ArenaBuildVariant } from "@/lib/arena/types";
import type { VoxelViewerBuildMetrics } from "@/components/voxel/VoxelViewer";
import type { ClientMetricSample } from "@/lib/observability/customMetrics";
import {
  getArenaBlockCountBucket,
  roundMetricMs,
} from "@/lib/observability/arenaMetrics";

const MAX_BATCH_SIZE = 50;
const FLUSH_DELAY_MS = 1_000;
const pendingSamples: ClientMetricSample[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushClientMetrics() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const samples = pendingSamples.splice(0, MAX_BATCH_SIZE);
  if (samples.length === 0) return;

  void fetch("/api/observability/client-metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ samples }),
    keepalive: true,
  }).catch(() => undefined);

  if (pendingSamples.length > 0) {
    flushTimer = setTimeout(flushClientMetrics, FLUSH_DELAY_MS);
  }
}

export function enqueueClientMetric(sample: ClientMetricSample) {
  if (typeof window === "undefined") return;
  pendingSamples.push(sample);
  if (pendingSamples.length >= MAX_BATCH_SIZE) {
    flushClientMetrics();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushClientMetrics, FLUSH_DELAY_MS);
  }
}

export function enqueueVoxelMetric(
  surface: "arena" | "sandbox",
  variant: ArenaBuildVariant,
  metrics: VoxelViewerBuildMetrics,
) {
  enqueueClientMetric({
    kind: "voxel",
    surface,
    variant,
    strategy: metrics.strategy,
    cacheStatus: metrics.cacheStatus,
    blockCountBucket: getArenaBlockCountBucket(metrics.inputBlockCount),
    renderedBlockCountBucket: getArenaBlockCountBucket(metrics.renderedBlockCount),
    animated: metrics.animated,
    queueMs: roundMetricMs(metrics.queueMs),
    atlasMs: roundMetricMs(metrics.atlasMs),
    payloadMs: roundMetricMs(metrics.payloadMs),
    groupMs: roundMetricMs(metrics.groupMs),
    meshMs: roundMetricMs(metrics.meshMs),
    firstRenderMs: roundMetricMs(metrics.firstRenderMs),
    revealMs: roundMetricMs(metrics.revealMs),
    totalMs: roundMetricMs(metrics.totalMs),
  });
}
