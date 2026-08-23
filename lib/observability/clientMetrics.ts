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
  surface: "arena" | "sandbox" | "leaderboard",
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

export function normalizeDeliverySource(
  response: Response,
): "artifact" | "live" | "artifact-required" | "artifact-redirect" | "response-cache" | "unknown" {
  const source =
    response.headers.get("x-build-source") ?? response.headers.get("x-build-stream-source");
  if (source === "artifact") return "artifact";
  if (source === "live") return "live";
  if (source === "artifact-required") return "artifact-required";
  if (source === "artifact-redirect") return "artifact-redirect";
  if (source?.startsWith("response-cache:")) return "response-cache";
  if (response.redirected) return "artifact-redirect";
  return "unknown";
}

export function enqueueDeliveryMetric(params: {
  surface: "arena" | "sandbox" | "leaderboard";
  purpose?: "visible" | "prefetch";
  variant: ArenaBuildVariant;
  transport: "snapshot" | "stream-artifact" | "stream-live";
  requestedFormat: "v4" | "json" | "ndjson";
  servedFormat: "binary" | "json" | "ndjson";
  response: Response;
  blockCount: number;
  totalMs: number | null;
  headersMs?: number | null;
  bodyMs?: number | null;
  inflateMs?: number | null;
  decodeMs?: number | null;
  bodyBytes?: number | null;
  compressed?: boolean;
}) {
  const source = normalizeDeliverySource(params.response);
  const encoding = (
    params.response.headers.get("content-encoding") ??
    params.response.headers.get("x-build-content-encoding") ??
    ""
  ).toLowerCase();
  const isGzip = encoding.includes("gzip");
  const compressed = Boolean(params.compressed || isGzip);
  const optimized =
    params.requestedFormat === "v4" &&
    params.servedFormat === "binary" &&
    (source === "artifact" || source === "artifact-redirect");
  enqueueClientMetric({
    kind: "delivery",
    surface: params.surface,
    purpose: params.purpose ?? "visible",
    variant: params.variant,
    transport: params.transport,
    requestedFormat: params.requestedFormat,
    servedFormat: params.servedFormat,
    delivery_source: source,
    blockCountBucket: getArenaBlockCountBucket(params.blockCount),
    compressed,
    optimized,
    headersMs: roundMetricMs(params.headersMs),
    bodyMs: roundMetricMs(params.bodyMs),
    inflateMs: roundMetricMs(params.inflateMs),
    decodeMs: roundMetricMs(params.decodeMs),
    totalMs: roundMetricMs(params.totalMs),
    bodyBytes: params.bodyBytes ?? null,
  });
}
