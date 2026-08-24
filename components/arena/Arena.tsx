"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArenaAction,
  ArenaBuildDeliveryClass,
  ArenaBuildRef,
  ArenaBuildVariant,
  ArenaMatchup,
  ArenaMatchupLane,
  ArenaModelReveal,
  ArenaVoteResponse,
  VoteChoice,
} from "@/lib/arena/types";
import { readClientErrorResponse } from "@/lib/clientErrorResponse";
import {
  IncompleteBuildStreamError,
  packDeliveredBuild,
  readBuildVariantPayload,
  readBuildVariantStream,
  type BuildVariantPayloadResult,
  type BuildStreamProgress,
  type BuildVariantStreamResponse,
} from "@/lib/arena/clientBuildResponse";
import {
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { getPalette } from "@/lib/blocks/palettes";
import {
  createVoxelMeshPayloadInWorker,
  type VoxelMeshPayload,
} from "@/lib/voxel/mesh";
import { claimArenaPremesh, type ArenaPremeshEntry } from "@/lib/arena/premesh";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import type { VoxelViewerBuildMetrics } from "@/components/voxel/VoxelViewer";
import { formatVoxelLoadingMessage } from "@/components/voxel/VoxelLoadingHud";
import { VoteBar, type VoteConfirmTarget } from "@/components/arena/VoteBar";
import { AnimatedPrompt } from "@/components/arena/AnimatedPrompt";
import { ModelReveal } from "@/components/arena/ModelReveal";
import { ErrorState } from "@/components/ErrorState";
import { trackEvent } from "@/lib/analytics";
import {
  getArenaBlockCountBucket,
  getArenaLatencyBucket,
  roundMetricMs,
} from "@/lib/observability/arenaMetrics";
import {
  createBrowserPerformanceTrace,
  type BrowserPerformanceTrace,
} from "@/lib/observability/browserPerformance";
import {
  enqueueClientMetric,
  enqueueMatchupStageMetric,
  enqueueVoxelMetric,
  normalizeDeliverySource,
} from "@/lib/observability/clientMetrics";

type ArenaState =
  | { kind: "loading" }
  | { kind: "ready"; matchup: ArenaMatchup }
  | { kind: "error"; message: string };

function modelRevealLabel(model: ArenaModelReveal | null | undefined): string | null {
  if (!model) return null;
  return model.provider === "Stealth" ? `Stealth • ${model.displayName}` : model.displayName;
}

// Reading the binary artifact is opt-in per request, so turning this off is a
// client deploy and needs no coordination with what storage holds.
const BINARY_ARTIFACT_READS_ENABLED =
  (process.env.NEXT_PUBLIC_ARENA_BINARY_ARTIFACT_READS_ENABLED ?? "").trim() === "1";
const MATCHUP_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_MATCHUP_REQUEST_TIMEOUT_MS ?? "12000",
  10,
);
const MATCHUP_REQUEST_RETRIES = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_MATCHUP_REQUEST_RETRIES ?? "0",
  10,
);
const FULL_HYDRATION_SLOW_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_FULL_HYDRATION_SLOW_MS ?? "2500",
  10,
);
const FULL_HYDRATION_RETRY_BASE_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_FULL_HYDRATION_RETRY_BASE_MS ?? "1200",
  10,
);
const FULL_HYDRATION_RETRY_MAX_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_FULL_HYDRATION_RETRY_MAX_MS ?? "15000",
  10,
);
const FULL_HYDRATION_AUTO_RETRY_MAX_ATTEMPTS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_FULL_HYDRATION_AUTO_RETRY_MAX_ATTEMPTS ?? "4",
  10,
);
const PREFETCH_INITIAL_MAX_BYTES = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_PREFETCH_INITIAL_MAX_BYTES ?? "524288",
  10,
);
let snapshotStorageRedirectBlocked = false;
let streamStorageRedirectBlocked = false;

const matchupRequestModes = new Map<string, "random" | "forced">();
function setMatchupRequestMode(id: string, mode: "random" | "forced") {
  if (matchupRequestModes.size > 200) {
    const firstKey = matchupRequestModes.keys().next().value;
    if (firstKey) matchupRequestModes.delete(firstKey);
  }
  matchupRequestModes.set(id, mode);
}

async function fetchMatchupOnce(promptId?: string, signal?: AbortSignal): Promise<ArenaMatchup> {
  const trace = createBrowserPerformanceTrace("matchup");
  trace.mark("fetch_start");
  try {
    const url = new URL("/api/arena/matchup", window.location.origin);
    if (promptId) url.searchParams.set("promptId", promptId);
    // Adaptive mode keeps small builds instant while deferring large payloads.
    url.searchParams.set("payload", "adaptive");
    const res = await fetch(url, { method: "GET", credentials: "include", signal });
    trace.mark("headers_received");
    if (!res.ok) throw new Error(await readClientErrorResponse(res, "Failed to load matchup"));
    const matchup = (await res.json()) as ArenaMatchup;
    const packedMatchup = {
      ...matchup,
      a: { ...matchup.a, build: packDeliveredBuild(matchup.a.build) },
      b: { ...matchup.b, build: packDeliveredBuild(matchup.b.build) },
    };
    trace.mark("matchup_received");
    const totalMs = trace.measure("total", "fetch_start", "matchup_received") ?? 0;
    const headersMs = roundMetricMs(
      trace.measure("headers", "fetch_start", "headers_received"),
    );
    const bodyMs = roundMetricMs(
      trace.measure("body", "headers_received", "matchup_received"),
    );
    const laneABlocks = getArenaBlockCountBucket(voxelBuildBlockCount(packedMatchup.a.build));
    const laneBBlocks = getArenaBlockCountBucket(voxelBuildBlockCount(packedMatchup.b.build));
    const mode: "random" | "forced" = promptId ? "forced" : "random";
    setMatchupRequestMode(packedMatchup.id, mode);
    trackEvent("arena_matchup_received", {
      path: `${mode}:adaptive`,
      samplingLane: matchup.samplingLane ?? "unknown",
      laneABlocks,
      laneBBlocks,
      headersMs,
      bodyMs,
      totalMs: roundMetricMs(totalMs),
      latency: getArenaLatencyBucket(totalMs),
    });
    enqueueClientMetric({
      kind: "matchup",
      mode,
      laneABlocks,
      laneBBlocks,
      headersMs,
      bodyMs,
      totalMs: roundMetricMs(totalMs),
    });
    return packedMatchup;
  } finally {
    trace.clear();
  }
}

async function fetchMatchup(
  promptId?: string,
  parentSignal?: AbortSignal,
): Promise<ArenaMatchup> {
  const maxAttempts = Math.max(1, MATCHUP_REQUEST_RETRIES + 1);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // compose caller's abort signal with our per-attempt timeout so either
    // source (retry cleanup, navigation, user cancel) can kill in-flight reqs
    const timed = makeTimeoutSignal(parentSignal, MATCHUP_REQUEST_TIMEOUT_MS);
    try {
      return await fetchMatchupOnce(promptId, timed.signal);
    } catch (err: unknown) {
      // if the caller aborted, stop retrying and surface the abort — the
      // effect/caller will handle it (typically by ignoring the result)
      if (parentSignal?.aborted) {
        throw err instanceof Error ? err : new DOMException("Aborted", "AbortError");
      }
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error("Matchup request timed out");
        if (attempt >= maxAttempts) {
          trackEvent("arena_matchup_timeout", {
            timeoutMs: MATCHUP_REQUEST_TIMEOUT_MS,
            attempts: maxAttempts,
            promptMode: promptId ? "forced" : "random",
          });
        }
      } else {
        lastError = err;
      }
    } finally {
      timed.cleanup();
    }
  }

  throw (lastError instanceof Error ? lastError : new Error("Failed to load matchup"));
}

const VOTE_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_VOTE_REQUEST_TIMEOUT_MS ?? "10000",
  10,
);

async function submitArenaAction(matchupId: string, action: ArenaAction): Promise<ArenaVoteResponse> {
  const failureMessage = action === "SKIP" ? "Couldn't reveal this matchup." : "Couldn't record your vote.";
  // hard timeout so a stalled arena action can't hang the reveal state
  const timed = makeTimeoutSignal(undefined, VOTE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("/api/arena/vote", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchupId, choice: action }),
      signal: timed.signal,
    });
    if (!res.ok) throw new Error(await readClientErrorResponse(res, failureMessage));
    const response = (await res.json()) as ArenaVoteResponse;
    if (!response?.reveal?.a?.displayName || !response.reveal.b?.displayName) {
      throw new Error(
        action === "SKIP"
          ? "The model reveal was unavailable. Refresh to continue."
          : "The vote saved, but the model reveal was unavailable. Refresh to continue.",
      );
    }
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        action === "SKIP"
          ? "Reveal timed out — the site may be under heavy load. Please try again."
          : "Vote timed out — the site may be under heavy load. Please try again.",
      );
    }
    if (err instanceof TypeError) {
      // Network failure (offline, DNS, CORS, etc.)
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }
    throw err;
  } finally {
    timed.cleanup();
  }
}

type BuildVariantResponse = BuildVariantStreamResponse;
type BuildRequestPurpose = "visible" | "prefetch";
type BuildTransport = "snapshot" | "stream-artifact" | "stream-live";

type BuildDeliveryMetrics = {
  trace: BrowserPerformanceTrace;
  startStage: "preview_fetch_start" | "full_fetch_start";
  purpose: BuildRequestPurpose;
  transport: BuildTransport;
};

function startBuildDeliveryMetrics(
  ref: ArenaBuildRef,
  purpose: BuildRequestPurpose,
  transport: BuildTransport,
): BuildDeliveryMetrics {
  const trace = createBrowserPerformanceTrace("build-delivery");
  const startStage = ref.variant === "preview" ? "preview_fetch_start" : "full_fetch_start";
  trace.mark(startStage);
  return { trace, startStage, purpose, transport };
}

async function readMeasuredBuildVariantPayload(
  response: Response,
  metrics: BuildDeliveryMetrics,
): Promise<BuildVariantPayloadResult> {
  const result = await readBuildVariantPayload(response, (event) => {
    if (event.stage === "body_complete") metrics.trace.mark("body_complete");
    if (event.stage === "inflate_complete") metrics.trace.mark("inflate_complete");
    if (
      event.stage === "binary_decode_complete" ||
      event.stage === "json_decode_complete"
    ) {
      metrics.trace.mark(event.stage);
      metrics.trace.mark("decode_complete");
    }
  });
  metrics.trace.mark("payload_ready");
  return result;
}

function normalizeBuildDeliveryClass(response: Response): ArenaBuildDeliveryClass | "unknown" {
  const value = response.headers.get("x-build-delivery-class");
  return value === "inline" ||
    value === "snapshot" ||
    value === "stream-live" ||
    value === "stream-artifact"
    ? value
    : "unknown";
}

function reportBuildDeliveryMetrics(opts: {
  metrics: BuildDeliveryMetrics;
  ref: ArenaBuildRef;
  response: Response;
  requestedFormat: "v4" | "json" | "ndjson";
  servedFormat: "binary" | "json" | "ndjson";
  payload: BuildVariantResponse;
  bodyBytes: number | null;
  compressed: boolean;
}) {
  const { metrics } = opts;
  const source = normalizeDeliverySource(opts.response);
  const deliveryClass = normalizeBuildDeliveryClass(opts.response);
  const blockCountBucket = getArenaBlockCountBucket(
    voxelBuildBlockCount(opts.payload.voxelBuild),
  );
  const path = `${metrics.purpose}:${opts.ref.variant}:${metrics.transport}`;
  const totalMs =
    metrics.trace.measure("total", metrics.startStage, "payload_ready") ?? 0;
  const optimized =
    opts.requestedFormat === "v4" &&
    opts.servedFormat === "binary" &&
    (source === "artifact" || source === "artifact-redirect");
  const headersMs = roundMetricMs(
    metrics.trace.measure("headers", metrics.startStage, "headers_received"),
  );
  const bodyMs = roundMetricMs(
    metrics.trace.measure("body", "headers_received", "body_complete"),
  );
  const inflateMs = roundMetricMs(
    metrics.trace.measure("inflate", "body_complete", "inflate_complete"),
  );
  const decodeMs = roundMetricMs(
    metrics.trace.measure("decode", "inflate_complete", "decode_complete"),
  );

  // Web Analytics Plus accepts at most eight properties per custom event
  trackEvent("arena_build_delivery", {
    path,
    requestedFormat: opts.requestedFormat,
    servedFormat: opts.servedFormat,
    source,
    deliveryClass,
    optimized,
    blockCountBucket,
    gzip: opts.compressed,
  });
  trackEvent("arena_build_delivery_timing", {
    path: `${path}:${opts.servedFormat}`,
    blockCountBucket,
    headersMs,
    bodyMs,
    inflateMs,
    decodeMs,
    totalMs: roundMetricMs(totalMs),
    bodyBytes: opts.bodyBytes,
  });
  enqueueClientMetric({
    kind: "delivery",
    surface: "arena",
    purpose: metrics.purpose,
    variant: opts.ref.variant,
    transport: metrics.transport,
    requestedFormat: opts.requestedFormat,
    servedFormat: opts.servedFormat,
    delivery_source: source,
    blockCountBucket,
    compressed: opts.compressed,
    optimized,
    headersMs,
    bodyMs,
    inflateMs,
    decodeMs,
    totalMs: roundMetricMs(totalMs),
    bodyBytes: opts.bodyBytes,
  });
}

function reportBuildRenderMetrics(
  variant: ArenaBuildVariant,
  metrics: VoxelViewerBuildMetrics,
) {
  const path = `${variant}:${metrics.strategy}:${metrics.cacheStatus}`;
  const blockCountBucket = getArenaBlockCountBucket(metrics.inputBlockCount);
  trackEvent("arena_build_mesh_timing", {
    path,
    blockCountBucket,
    queueMs: roundMetricMs(metrics.queueMs),
    atlasMs: roundMetricMs(metrics.atlasMs),
    payloadMs: roundMetricMs(metrics.payloadMs),
    groupMs: roundMetricMs(metrics.groupMs),
    meshMs: roundMetricMs(metrics.meshMs),
    totalMs: roundMetricMs(metrics.totalMs),
  });
  trackEvent("arena_build_render_timing", {
    path,
    blockCountBucket,
    renderedBlockCountBucket: getArenaBlockCountBucket(metrics.renderedBlockCount),
    firstRenderMs: roundMetricMs(metrics.firstRenderMs),
    revealMs: roundMetricMs(metrics.revealMs),
    totalMs: roundMetricMs(metrics.totalMs),
    animated: metrics.animated,
  });
  enqueueVoxelMetric("arena", variant, metrics);
}

type FetchBuildVariantStreamOptions = {
  signal?: AbortSignal;
  onProgress?: (build: ArenaMatchup["a"]["build"], progress: BuildStreamProgress) => void;
  allowSnapshotFallback?: boolean;
  allowLiveFallback?: boolean;
  purpose?: BuildRequestPurpose;
};

const SNAPSHOT_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_SNAPSHOT_TIMEOUT_MS ?? "12000",
  10,
);
const STREAM_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_REQUEST_TIMEOUT_MS ?? "12000",
  10,
);
const INITIAL_RETRIEVAL_OVERLAY_DELAY_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_INITIAL_RETRIEVAL_OVERLAY_DELAY_MS ?? "420",
  10,
);
// client memory budgets. mobile defaults are roughly 40% of desktop because
// safari ios kills tabs near 350-500 MB and large builds plus three.js geometry
// already use most of that envelope.
function detectIsMobileEnv(): boolean {
  if (typeof window === "undefined") return false;
  // hardware proxy first; deviceMemory is unreliable on safari
  const ua = window.navigator?.userAgent?.toLowerCase() ?? "";
  const uaMobile = /iphone|ipod|ipad|android|mobile/.test(ua);
  const coarsePointer =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false;
  return uaMobile || coarsePointer;
}
const IS_MOBILE_ENV = detectIsMobileEnv();
const MOBILE_SCALE = 0.4;
const CLIENT_BUILD_CACHE_MAX_ENTRIES = Math.max(
  1,
  Math.round(
    Number.parseInt(
      process.env.NEXT_PUBLIC_ARENA_CLIENT_BUILD_CACHE_MAX_ENTRIES ?? "8",
      10,
    ) * (IS_MOBILE_ENV ? MOBILE_SCALE : 1),
  ),
);
const CLIENT_BUILD_CACHE_MAX_EST_BYTES = Math.round(
  Number.parseInt(
    process.env.NEXT_PUBLIC_ARENA_CLIENT_BUILD_CACHE_MAX_EST_BYTES ?? "60000000",
    10,
  ) * (IS_MOBILE_ENV ? MOBILE_SCALE : 1),
);
// client caps keep prefetch from eating renderer memory
const CLIENT_BUILD_CACHE_MAX_TOTAL_EST_BYTES = Math.round(
  Number.parseInt(
    process.env.NEXT_PUBLIC_ARENA_CLIENT_BUILD_CACHE_MAX_TOTAL_EST_BYTES ?? "90000000",
    10,
  ) * (IS_MOBILE_ENV ? MOBILE_SCALE : 1),
);
const CLIENT_FULL_PREFETCH_MAX_EST_BYTES = Math.round(
  Number.parseInt(
    process.env.NEXT_PUBLIC_ARENA_FULL_PREFETCH_MAX_EST_BYTES ?? "30000000",
    10,
  ) * (IS_MOBILE_ENV ? MOBILE_SCALE : 1),
);
const CLIENT_FULL_PREFETCH_MAX_IN_FLIGHT = IS_MOBILE_ENV
  ? 0
  : Number.parseInt(
      process.env.NEXT_PUBLIC_ARENA_FULL_PREFETCH_MAX_IN_FLIGHT ?? "2",
      10,
    );

type CachedHydratedBuild = {
  build: NonNullable<ArenaMatchup["a"]["build"]>;
  serverValidated: boolean;
  variant: ArenaBuildVariant;
  buildLoadHints?: ArenaMatchup["a"]["buildLoadHints"];
};

type FullBuildPrefetch = {
  matchupId: string;
  controller: AbortController;
  promise: Promise<BuildVariantResponse> | null;
  progress: BuildStreamProgress | null;
  listeners: Set<(progress: BuildStreamProgress) => void>;
};

type AutoFullHydrationRetry = {
  attempts: number;
  nextRetryAt: number;
  exhausted?: boolean;
};

type TimeoutSignal = {
  signal: AbortSignal;
  cleanup: () => void;
};

function makeTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): TimeoutSignal {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer != null) window.clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

class BuildRetryAfterError extends Error {
  retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "BuildRetryAfterError";
    this.retryAfterMs = retryAfterMs;
  }
}

function readRetryAfterMs(res: Response, fallbackMs: number): number {
  const raw = res.headers.get("Retry-After")?.trim();
  if (!raw) return fallbackMs;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(250, Math.min(5000, seconds * 1000));
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(250, Math.min(5000, dateMs - Date.now()));
  }
  return fallbackMs;
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    let timer: number | null = null;
    let cleanup = () => {};
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    cleanup = () => {
      if (timer != null) window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldRetrySnapshotWithoutRedirect(status: number): boolean {
  // 429 and 503 mean back off or stream
  return [400, 403, 404, 500, 502, 504].includes(status);
}

function markStorageRedirectBlocked(kind: "snapshot" | "stream") {
  if (kind === "snapshot") {
    if (snapshotStorageRedirectBlocked) return;
    snapshotStorageRedirectBlocked = true;
  } else {
    if (streamStorageRedirectBlocked) return;
    streamStorageRedirectBlocked = true;
  }
  trackEvent("arena_storage_redirect_blocked", { kind });
}

async function fetchBuildVariantSnapshot(
  ref: ArenaBuildRef,
  signal?: AbortSignal,
  timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS,
  opts?: {
    redirect?: boolean;
    purpose?: BuildRequestPurpose;
    metrics?: BuildDeliveryMetrics;
  },
): Promise<BuildVariantResponse> {
  const url = new URL(`/api/arena/builds/${encodeURIComponent(ref.buildId)}`, window.location.origin);
  url.searchParams.set("variant", ref.variant);
  if (ref.checksum) url.searchParams.set("checksum", ref.checksum);
  const allowRedirect = opts?.redirect !== false && !snapshotStorageRedirectBlocked;
  if (!allowRedirect) url.searchParams.set("redirect", "0");
  if (BINARY_ARTIFACT_READS_ENABLED) url.searchParams.set("format", "v4");
  const ownsMetrics = opts?.metrics == null;
  const metrics =
    opts?.metrics ??
    startBuildDeliveryMetrics(ref, opts?.purpose ?? "visible", "snapshot");
  const timed = makeTimeoutSignal(signal, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        credentials: "same-origin",
        signal: timed.signal,
        redirect: "follow",
      });
      metrics.trace.mark("headers_received");
    } catch (err: unknown) {
      if (allowRedirect && !isAbortError(err)) {
        markStorageRedirectBlocked("snapshot");
        return await fetchBuildVariantSnapshot(ref, signal, timeoutMs, {
          redirect: false,
          purpose: opts?.purpose,
          metrics,
        });
      }
      throw err;
    }
    if (!res.ok) {
      if (allowRedirect && shouldRetrySnapshotWithoutRedirect(res.status)) {
        return await fetchBuildVariantSnapshot(ref, signal, timeoutMs, {
          redirect: false,
          purpose: opts?.purpose,
          metrics,
        });
      }
      const message = await readClientErrorResponse(res, "Couldn't load build");
      throw new Error(message);
    }
    const result = await readMeasuredBuildVariantPayload(res, metrics);
    reportBuildDeliveryMetrics({
      metrics,
      ref,
      response: res,
      requestedFormat: BINARY_ARTIFACT_READS_ENABLED ? "v4" : "json",
      servedFormat: result.servedFormat,
      payload: result.payload,
      bodyBytes: result.bodyBytes,
      compressed:
        result.compressed || /\bgzip\b/i.test(res.headers.get("content-encoding") ?? ""),
    });
    return result.payload;
  } finally {
    timed.cleanup();
    if (ownsMetrics) metrics.trace.clear();
  }
}

async function fetchBuildVariantStreamOnce(
  ref: ArenaBuildRef,
  useArtifact: boolean,
  opts?: FetchBuildVariantStreamOptions,
): Promise<BuildVariantResponse> {
  const metrics = startBuildDeliveryMetrics(
    ref,
    opts?.purpose ?? "visible",
    useArtifact ? "stream-artifact" : "stream-live",
  );
  try {
    return await fetchBuildVariantStreamOnceWithMetrics(ref, useArtifact, metrics, opts);
  } finally {
    metrics.trace.clear();
  }
}

async function fetchBuildVariantStreamOnceWithMetrics(
  ref: ArenaBuildRef,
  useArtifact: boolean,
  metrics: BuildDeliveryMetrics,
  opts?: FetchBuildVariantStreamOptions,
): Promise<BuildVariantResponse> {
  const url = new URL(
    `/api/arena/builds/${encodeURIComponent(ref.buildId)}/stream`,
    window.location.origin,
  );
  url.searchParams.set("variant", ref.variant);
  if (ref.checksum) url.searchParams.set("checksum", ref.checksum);
  if (!useArtifact) url.searchParams.set("artifact", "0");

  const requestTimed = makeTimeoutSignal(opts?.signal, STREAM_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      signal: requestTimed.signal,
    });
    metrics.trace.mark("headers_received");
  } catch (error) {
    if (useArtifact && !isAbortError(error)) markStorageRedirectBlocked("stream");
    throw error;
  } finally {
    requestTimed.cleanup();
  }
  if (!res.ok) {
    const retryAfterMs = readRetryAfterMs(res, 1000);
    const message = await readClientErrorResponse(res, "Couldn't load build");
    if (useArtifact && ref.variant === "full" && res.status === 503) {
      throw new BuildRetryAfterError(message, retryAfterMs);
    }
    throw new Error(message);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.body || !contentType.includes("application/x-ndjson")) {
    const result = await readMeasuredBuildVariantPayload(res, metrics);
    reportBuildDeliveryMetrics({
      metrics,
      ref,
      response: res,
      requestedFormat: "ndjson",
      servedFormat: result.servedFormat,
      payload: result.payload,
      bodyBytes: result.bodyBytes,
      compressed:
        result.compressed || /\bgzip\b/i.test(res.headers.get("content-encoding") ?? ""),
    });
    return result.payload;
  }

  try {
    const payload = await readBuildVariantStream(res, {
      signal: opts?.signal,
      onProgress: opts?.onProgress,
      onStage(stage) {
        if (stage === "body_complete") {
          metrics.trace.mark("body_complete");
          // Stream decompression and decoding happen incrementally while the body arrives.
          metrics.trace.mark("inflate_complete");
        } else {
          metrics.trace.mark("decode_complete");
        }
      },
    });
    metrics.trace.mark("payload_ready");
    const contentLength = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    reportBuildDeliveryMetrics({
      metrics,
      ref,
      response: res,
      requestedFormat: "ndjson",
      servedFormat: "ndjson",
      payload,
      bodyBytes: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
      compressed: /\bgzip\b/i.test(res.headers.get("content-encoding") ?? ""),
    });
    return payload;
  } catch (error) {
    if (
      error instanceof IncompleteBuildStreamError &&
      opts?.allowSnapshotFallback !== false
    ) {
      return fetchBuildVariantSnapshot(ref, opts?.signal, SNAPSHOT_FETCH_TIMEOUT_MS, {
        purpose: opts?.purpose,
      });
    }
    throw error;
  }
}

async function fetchBuildVariantStream(
  ref: ArenaBuildRef,
  opts?: FetchBuildVariantStreamOptions,
): Promise<BuildVariantResponse> {
  let lastError: unknown = null;
  const attempts: Array<() => Promise<BuildVariantResponse>> = [];
  if (!streamStorageRedirectBlocked) {
    attempts.push(() => fetchBuildVariantStreamOnce(ref, true, opts));
  }
  if (ref.variant === "full" && opts?.allowLiveFallback !== false) {
    attempts.push(() => fetchBuildVariantStreamOnce(ref, false, opts));
  }
  if (opts?.allowSnapshotFallback !== false) {
    attempts.push(() =>
      fetchBuildVariantSnapshot(ref, opts?.signal, SNAPSHOT_FETCH_TIMEOUT_MS, {
        purpose: opts?.purpose,
      }),
    );
  }

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError" && opts?.signal?.aborted) {
        throw err;
      }
      if (err instanceof BuildRetryAfterError) {
        lastError = err;
        await sleepWithSignal(err.retryAfterMs, opts?.signal);
        continue;
      }
      lastError = err;
    }
  }

  throw (lastError instanceof Error ? lastError : new Error("Failed to retrieve build"));
}

function withHydratedBuild(
  matchup: ArenaMatchup,
  side: "a" | "b",
  build: ArenaMatchup["a"]["build"],
  serverValidated: boolean,
  hydratedVariant: ArenaBuildVariant,
  hydratedRef?: ArenaBuildRef,
  hydratedHints?: ArenaMatchup["a"]["buildLoadHints"],
): ArenaMatchup {
  const lane = matchup[side];
  const baseHints = hydratedHints ?? lane.buildLoadHints;
  const nextBuildId = hydratedRef?.buildId ?? lane.buildRef?.buildId ?? lane.previewRef?.buildId;
  const nextChecksum = hydratedRef?.checksum ?? lane.buildRef?.checksum ?? lane.previewRef?.checksum ?? null;
  const updatedLane = {
    ...lane,
    build,
    buildRef: lane.buildRef
      ? {
          ...lane.buildRef,
          buildId: nextBuildId ?? lane.buildRef.buildId,
          checksum: nextChecksum,
        }
      : lane.buildRef,
    previewRef: lane.previewRef
      ? {
          ...lane.previewRef,
          buildId: nextBuildId ?? lane.previewRef.buildId,
          checksum: nextChecksum,
        }
      : lane.previewRef,
    serverValidated: lane.serverValidated || serverValidated,
    buildLoadHints: baseHints
      ? {
          ...baseHints,
          initialVariant:
            hydratedVariant === "full"
              ? ("full" as ArenaBuildVariant)
              : baseHints.initialVariant,
          previewBlockCount:
            hydratedVariant === "preview" && build
              ? voxelBuildBlockCount(build)
              : baseHints.previewBlockCount,
        }
      : baseHints,
  };

  if (side === "a") {
    return { ...matchup, a: updatedLane };
  }
  return { ...matchup, b: updatedLane };
}

type SideLoadPhase = "idle" | "loading-initial" | "loading-full";
type SideLoadProgress = {
  receivedBlocks: number;
  totalBlocks: number | null;
};
type SideLoadState = {
  matchupId: string;
  a: SideLoadPhase;
  b: SideLoadPhase;
  aOverlayVisible: boolean;
  bOverlayVisible: boolean;
  aProgress: SideLoadProgress | null;
  bProgress: SideLoadProgress | null;
  aError: string | null;
  bError: string | null;
};

function laneNeedsFullHydration(lane: ArenaMatchup["a"]): boolean {
  if (!laneExpectsFullHydration(lane)) return false;
  if (!lane.build) return false;
  const full = lane.buildLoadHints?.fullBlockCount ?? 0;
  return voxelBuildBlockCount(lane.build) < full;
}

function laneExpectsFullHydration(lane: ArenaMatchup["a"]): boolean {
  const hints = lane.buildLoadHints;
  if (!hints || hints.initialVariant !== "preview") return false;
  const full = hints.fullBlockCount ?? 0;
  const preview = hints.previewBlockCount ?? 0;
  if (!Number.isFinite(full) || full <= 0) return false;
  return !Number.isFinite(preview) || preview < full;
}

function laneShouldAutoUpgradeToFull(lane: ArenaMatchup["a"]): boolean {
  return laneNeedsFullHydration(lane);
}

function isMatchupInitialBuildLoading(matchup: ArenaMatchup, sideState: SideLoadState | null): boolean {
  if (!matchup.a.build || !matchup.b.build) return true;
  if (!sideState || sideState.matchupId !== matchup.id) return false;
  return sideState.a === "loading-initial" || sideState.b === "loading-initial";
}

function isMatchupVoteBlocked(matchup: ArenaMatchup, sideState: SideLoadState | null): boolean {
  if (!matchup.a.build || !matchup.b.build) return true;
  if (laneNeedsFullHydration(matchup.a) || laneNeedsFullHydration(matchup.b)) return true;
  if (!sideState || sideState.matchupId !== matchup.id) return false;
  return (
    sideState.a === "loading-initial" ||
    sideState.b === "loading-initial" ||
    sideState.a === "loading-full" ||
    sideState.b === "loading-full"
  );
}

function getInitialHydrateRef(matchup: ArenaMatchup, side: "a" | "b"): ArenaBuildRef | null {
  const lane = matchup[side];
  if (lane.build) return null;
  // Start with the server-selected initial variant (preview for huge builds).
  const initialVariant = lane.buildLoadHints?.initialVariant ?? "full";
  if (initialVariant === "preview") return lane.previewRef ?? lane.buildRef ?? null;
  return lane.buildRef ?? lane.previewRef ?? null;
}

function getHydratedBuildCacheKey(ref: ArenaBuildRef): string {
  return `${ref.buildId}:${ref.variant}:${ref.checksum ?? "none"}`;
}

function getAutoFullHydrationFailureKey(
  matchupId: string,
  side: "a" | "b",
  ref: ArenaBuildRef,
): string {
  return `${matchupId}:${side}:${ref.buildId}:${ref.checksum ?? "none"}`;
}

function getFullHydrationRetryDelayMs(attempts: number): number {
  const base =
    Number.isFinite(FULL_HYDRATION_RETRY_BASE_MS) && FULL_HYDRATION_RETRY_BASE_MS > 0
      ? FULL_HYDRATION_RETRY_BASE_MS
      : 1200;
  const max =
    Number.isFinite(FULL_HYDRATION_RETRY_MAX_MS) && FULL_HYDRATION_RETRY_MAX_MS > 0
      ? FULL_HYDRATION_RETRY_MAX_MS
      : 15000;
  const boundedAttempt = Math.max(0, Math.min(6, attempts - 1));
  return Math.min(max, base * 2 ** boundedAttempt);
}

function getFullHydrationAutoRetryMaxAttempts(): number {
  if (!Number.isFinite(FULL_HYDRATION_AUTO_RETRY_MAX_ATTEMPTS)) return 4;
  return Math.max(1, Math.min(10, Math.floor(FULL_HYDRATION_AUTO_RETRY_MAX_ATTEMPTS)));
}

function isHeavyRetrievalDeliveryClass(
  deliveryClass: ArenaBuildDeliveryClass | undefined,
): boolean {
  return deliveryClass === "stream-live" || deliveryClass === "stream-artifact";
}

function getInitialDeliveryClass(
  hints: ArenaMatchup["a"]["buildLoadHints"] | ArenaMatchup["b"]["buildLoadHints"] | undefined,
): ArenaBuildDeliveryClass | undefined {
  return hints?.initialDeliveryClass ?? hints?.deliveryClass;
}

function shouldPrefetchInitialBuild(
  hints: ArenaMatchup["a"]["buildLoadHints"] | ArenaMatchup["b"]["buildLoadHints"] | undefined,
): boolean {
  const deliveryClass = getInitialDeliveryClass(hints);
  if (deliveryClass !== "inline") return false;
  if (PREFETCH_INITIAL_MAX_BYTES <= 0) return false;
  const estimatedBytes = hints?.initialEstimatedBytes;
  return typeof estimatedBytes === "number" && estimatedBytes > 0 && estimatedBytes <= PREFETCH_INITIAL_MAX_BYTES;
}

function getHydrationDeliveryClass(
  hints: ArenaMatchup["a"]["buildLoadHints"] | ArenaMatchup["b"]["buildLoadHints"] | undefined,
  target: "initial" | "full",
): ArenaBuildDeliveryClass | undefined {
  return target === "initial" ? getInitialDeliveryClass(hints) : hints?.deliveryClass;
}

function shouldHydrateViaSnapshot(
  deliveryClass: ArenaBuildDeliveryClass | undefined,
): boolean {
  // A stream-class build is only too large for a whole-body fetch as JSON. The
  // binary encoding puts it well under the cap, so when the client can read it
  // the snapshot path is the faster route for every class.
  if (BINARY_ARTIFACT_READS_ENABLED) return true;
  return deliveryClass === "snapshot" || deliveryClass === "inline";
}

function getExpectedBlocksForLane(lane: ArenaMatchup["a"] | ArenaMatchup["b"]): number | undefined {
  const hints = lane.buildLoadHints;
  if (!hints) return undefined;
  const expected =
    hints.initialVariant === "preview" ? hints.previewBlockCount : hints.fullBlockCount;
  if (typeof expected !== "number" || !Number.isFinite(expected) || expected <= 0) return undefined;
  return Math.floor(expected);
}

function getLaneHydratedVariant(lane: ArenaMatchup["a"] | ArenaMatchup["b"]): ArenaBuildVariant {
  const fullBlockCount = lane.buildLoadHints?.fullBlockCount ?? 0;
  if (
    lane.build &&
    Number.isFinite(fullBlockCount) &&
    fullBlockCount > 0 &&
    voxelBuildBlockCount(lane.build) < fullBlockCount
  ) {
    return "preview";
  }
  return "full";
}

function getLaneMeshCacheKey(lane: ArenaMatchup["a"] | ArenaMatchup["b"]): string | null {
  if (!lane.build) return null;
  const variant = getLaneHydratedVariant(lane);
  const ref = variant === "preview" ? lane.previewRef ?? lane.buildRef : lane.buildRef ?? lane.previewRef;
  const checksum = ref?.checksum ?? lane.buildRef?.checksum ?? lane.previewRef?.checksum ?? null;
  if (!ref?.buildId || !checksum) return null;
  // a partial build would otherwise write a cache entry per streamed rebuild
  const expected = lane.buildLoadHints?.fullBlockCount ?? 0;
  const count = voxelBuildBlockCount(lane.build);
  if (variant === "full" && expected > 0 && count < expected) return null;
  return `${ref.buildId}:${variant}:${checksum}:${count}`;
}

function estimateCachedHydratedBuildBytes(entry: CachedHydratedBuild): number {
  if (entry.variant === "preview") {
    return Math.max(1, voxelBuildBlockCount(entry.build) * 34);
  }
  const estimated = entry.buildLoadHints?.fullEstimatedBytes;
  if (typeof estimated === "number" && Number.isFinite(estimated) && estimated > 0) {
    return Math.floor(estimated);
  }
  return Math.max(1, voxelBuildBlockCount(entry.build) * 34);
}

function getPositiveByteLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function estimateLaneFullBuildBytes(lane: ArenaMatchup["a"] | ArenaMatchup["b"]): number | null {
  const estimated = lane.buildLoadHints?.fullEstimatedBytes;
  if (typeof estimated === "number" && Number.isFinite(estimated) && estimated > 0) {
    return Math.floor(estimated);
  }
  const fullBlockCount = lane.buildLoadHints?.fullBlockCount;
  if (typeof fullBlockCount === "number" && Number.isFinite(fullBlockCount) && fullBlockCount > 0) {
    return Math.floor(fullBlockCount * 34);
  }
  if (voxelBuildBlockCount(lane.build) > 0) {
    return Math.floor(voxelBuildBlockCount(lane.build) * 34);
  }
  return null;
}

function shouldPrefetchFullLane(lane: ArenaMatchup["a"] | ArenaMatchup["b"]): boolean {
  const maxBytes = Number.isFinite(CLIENT_FULL_PREFETCH_MAX_EST_BYTES)
    ? Math.floor(CLIENT_FULL_PREFETCH_MAX_EST_BYTES)
    : 30_000_000;
  if (maxBytes <= 0) return false;
  // only hold offscreen full builds when they are small enough
  const estimated = estimateLaneFullBuildBytes(lane);
  return estimated != null && estimated <= maxBytes;
}

function formatBuildLoadingMessage(
  fullLoading: boolean,
  progress: SideLoadProgress | null,
): string {
  return formatVoxelLoadingMessage(fullLoading ? "Retrieving full build" : "Retrieving build", progress);
}

type RevealAction = ArenaAction;

type RevealState =
  | { kind: "none" }
  | {
      kind: "reveal";
      matchupId: string;
      action: RevealAction;
      startedAt: number | null;
      advanceAt: number | null;
      next: ArenaMatchup | null;
    };

const REVEAL_MS_AFTER_VOTE = 2600;
const REVEAL_MS_AFTER_SKIP = 1600;
const TRANSITION_OUT_MS = 220;
const BUILD_STUCK_AUTOSKIP_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_BUILD_STUCK_AUTOSKIP_MS ?? "45000",
  10,
);

function RevealLane({
  side,
  model,
  chosen,
  faded,
  delayed,
}: {
  side: "A" | "B";
  model?: { provider?: string; displayName?: string } | null;
  chosen: boolean;
  faded: boolean;
  delayed?: boolean;
}) {
  const isA = side === "A";
  const chosenRule = isA ? "border-accent" : "border-accent2";
  const sideTone = isA ? "text-accent" : "text-accent2";
  return (
    <div
      className={`mb-reveal-lane ${delayed ? "mb-reveal-lane-delay" : ""} flex min-w-0 flex-1 items-baseline gap-2 border-t-2 pt-1.5 transition-opacity duration-200 ${
        chosen ? chosenRule : "border-border/70"
      } ${faded ? "opacity-45" : "opacity-100"}`}
    >
      <span className={`shrink-0 font-mono text-[11px] font-semibold ${sideTone}`}>{side}</span>
      <span className="min-w-0 truncate text-[13px] font-medium text-fg">
        {model?.displayName ?? "—"}
      </span>
      {model?.provider ? (
        <span className="hidden shrink-0 font-mono text-[11px] text-muted2 sm:inline">
          {model.provider}
        </span>
      ) : null}
    </div>
  );
}

function PipelineArrow() {
  return (
    <div
      aria-hidden="true"
      className="hidden items-center justify-center text-muted/40 md:flex"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </div>
  );
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button,a,[role='button'],[role='link'],summary"));
}

const ARENA_PREMESH_MAX_BLOCK_COUNT = 150_000;

function getArenaPremeshedMeshKey(
  matchupId: string,
  side: "a" | "b",
  variant: ArenaBuildVariant,
): string {
  return `${matchupId}:${side}:${variant}`;
}

export function Arena() {
  const [state, setState] = useState<ArenaState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [slowInitialLoad, setSlowInitialLoad] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [voteConfirming, setVoteConfirming] = useState<VoteConfirmTarget | null>(null);
  const voteConfirmTimerRef = useRef<number | null>(null);
  const [voteWarning, setVoteWarning] = useState<string | null>(null);
  const voteWarningTimerRef = useRef<number | null>(null);
  const [reveal, setReveal] = useState<RevealState>({ kind: "none" });
  const [sideLoadState, setSideLoadState] = useState<SideLoadState | null>(null);
  const [viewerReady, setViewerReady] = useState<{ matchupId: string; a: boolean; b: boolean } | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const promptRowRef = useRef<HTMLDivElement | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [mobileBuildView, setMobileBuildView] = useState<"a" | "b">("a");
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  const [fullHydrationRetryTick, setFullHydrationRetryTick] = useState(0);
  const [, forceTick] = useState(0);
  const stateRef = useRef<ArenaState>({ kind: "loading" });
  const submittingRef = useRef(false);
  const transitioningStateRef = useRef(false);
  const cardsScrollRef = useRef<HTMLDivElement | null>(null);
  const programmaticMobileScrollRef = useRef<{ side: "a" | "b"; until: number } | null>(null);
  const revealRef = useRef<RevealState>({ kind: "none" });
  const transitionRef = useRef(false);
  const hydrateInFlightRef = useRef(new Set<string>());
  const initialHydrationControllersRef = useRef(new Map<string, AbortController>());
  const fullHydrationControllersRef = useRef(new Map<string, AbortController>());
  const hydratedBuildCacheRef = useRef(new Map<string, CachedHydratedBuild>());
  const hydratedBuildCacheWeightsRef = useRef(new Map<string, number>());
  const hydratedBuildCacheBytesRef = useRef(0);
  const fullBuildPrefetchRef = useRef(new Map<string, FullBuildPrefetch>());
  const premeshedFullMeshRef = useRef<Map<string, ArenaPremeshEntry>>(new Map());
  const inFlightWarmPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const matchupStagesRef = useRef<{
    matchupId: string;
    startAt: number;
    mode: "random" | "forced";
    previewReadyReported: boolean;
    voteReadyReported: boolean;
  } | null>(null);
  const sideLoadStateRef = useRef<SideLoadState | null>(null);
  const viewerReadyRef = useRef<{ matchupId: string; a: boolean; b: boolean } | null>(null);
  const autoFullHydrationRetriesRef = useRef(new Map<string, AutoFullHydrationRetry>());
  const autoFullHydrationRetryTimersRef = useRef(new Map<string, number>());
  const autoAdvanceTimeoutRef = useRef<number | null>(null);
  const stuckAutoSkipTimeoutRef = useRef<number | null>(null);
  const advanceNowRequestedAtRef = useRef<number | null>(null);
  const nextMatchupLoadingRef = useRef(false);
  const handleVoteRef = useRef<(choice: VoteChoice) => Promise<void>>(
    async () => undefined
  );
  const handleSkipRef = useRef<() => Promise<void>>(async () => undefined);
  const advanceToNextRef = useRef<(matchupId: string, next: ArenaMatchup) => Promise<void>>(
    async () => undefined
  );
  const loadNextMatchupRef = useRef<(matchupId: string, advanceAt: number) => Promise<void>>(
    async () => undefined,
  );

  const setLaneLoadPhase = useCallback((matchupId: string, side: "a" | "b", phase: SideLoadPhase) => {
    setSideLoadState((prev) => {
      if (!prev) return prev;
      if (prev.matchupId !== matchupId) return prev;
      if (prev[side] === phase) return prev;
      const progressKey = side === "a" ? "aProgress" : "bProgress";
      const overlayKey = side === "a" ? "aOverlayVisible" : "bOverlayVisible";
      const errorKey = side === "a" ? "aError" : "bError";
      return {
        ...prev,
        [side]: phase,
        [overlayKey]: phase === "idle" ? false : prev[overlayKey],
        [progressKey]: phase === "idle" ? null : prev[progressKey],
        [errorKey]: phase === "idle" ? prev[errorKey] : null,
      };
    });
  }, []);

  const setLaneOverlayVisible = useCallback(
    (matchupId: string, side: "a" | "b", visible: boolean) => {
      setSideLoadState((prev) => {
        if (!prev || prev.matchupId !== matchupId) return prev;
        const overlayKey = side === "a" ? "aOverlayVisible" : "bOverlayVisible";
        if (prev[overlayKey] === visible) return prev;
        return {
          ...prev,
          [overlayKey]: visible,
        };
      });
    },
    [],
  );

  // Streaming mutates one container in place, so the lane keeps the same build
  // object as blocks arrive and the viewer treats it as the same build growing
  // rather than a new one replacing it.
  const setLaneProgressiveBuild = useCallback(
    (matchupId: string, side: "a" | "b", build: NonNullable<ArenaMatchup["a"]["build"]>) => {
      setState((prev) => {
        if (prev.kind !== "ready" || prev.matchup.id !== matchupId) return prev;
        const lane = prev.matchup[side];
        if (lane.build === build) return prev;
        return {
          ...prev,
          matchup: { ...prev.matchup, [side]: { ...lane, build } },
        };
      });
    },
    [],
  );

  const setLaneLoadProgress = useCallback(
    (matchupId: string, side: "a" | "b", progress: SideLoadProgress | null) => {
      setSideLoadState((prev) => {
        if (!prev || prev.matchupId !== matchupId) return prev;
        const progressKey = side === "a" ? "aProgress" : "bProgress";
        const current = prev[progressKey];
        const unchanged =
          current?.receivedBlocks === progress?.receivedBlocks &&
          current?.totalBlocks === progress?.totalBlocks;
        if (unchanged) return prev;
        return {
          ...prev,
          [progressKey]: progress,
        };
      });
    },
    [],
  );

  const setLaneLoadError = useCallback(
    (matchupId: string, side: "a" | "b", message: string | null) => {
      setSideLoadState((prev) => {
        if (!prev || prev.matchupId !== matchupId) return prev;
        const errorKey = side === "a" ? "aError" : "bError";
        if (prev[errorKey] === message) return prev;
        return {
          ...prev,
          [errorKey]: message,
        };
      });
    },
    [],
  );

  const markViewerLaneNotReady = useCallback((matchupId: string, side: "a" | "b") => {
    setViewerReady((prev) => {
      if (!prev || prev.matchupId !== matchupId) return prev;
      if (!prev[side]) return prev;
      return { ...prev, [side]: false };
    });
  }, []);

  const clearAutoFullHydrationRetryTimer = useCallback((key: string) => {
    const timer = autoFullHydrationRetryTimersRef.current.get(key);
    if (timer == null) return;
    window.clearTimeout(timer);
    autoFullHydrationRetryTimersRef.current.delete(key);
  }, []);

  const scheduleAutoFullHydrationRetryWake = useCallback(
    (key: string, delayMs: number) => {
      clearAutoFullHydrationRetryTimer(key);
      const delay = Math.max(250, Math.ceil(delayMs));
      const timer = window.setTimeout(() => {
        autoFullHydrationRetryTimersRef.current.delete(key);
        setFullHydrationRetryTick((tick) => tick + 1);
      }, delay);
      autoFullHydrationRetryTimersRef.current.set(key, timer);
    },
    [clearAutoFullHydrationRetryTimer],
  );

  const clearAutoFullHydrationRetry = useCallback(
    (key: string) => {
      autoFullHydrationRetriesRef.current.delete(key);
      clearAutoFullHydrationRetryTimer(key);
    },
    [clearAutoFullHydrationRetryTimer],
  );

  const registerAutoFullHydrationFailure = useCallback(
    (key: string) => {
      const previous = autoFullHydrationRetriesRef.current.get(key);
      const attempts = (previous?.attempts ?? 0) + 1;
      const maxAttempts = getFullHydrationAutoRetryMaxAttempts();
      if (attempts >= maxAttempts) {
        // manual retry stays available after the cap
        autoFullHydrationRetriesRef.current.set(key, {
          attempts,
          nextRetryAt: Number.POSITIVE_INFINITY,
          exhausted: true,
        });
        clearAutoFullHydrationRetryTimer(key);
        return;
      }
      const delay = getFullHydrationRetryDelayMs(attempts);
      const nextRetryAt = Date.now() + delay;
      autoFullHydrationRetriesRef.current.set(key, { attempts, nextRetryAt });
      scheduleAutoFullHydrationRetryWake(key, delay);
    },
    [clearAutoFullHydrationRetryTimer, scheduleAutoFullHydrationRetryWake],
  );

  const matchup = state.kind === "ready" ? state.matchup : null;
  const revealModels = Boolean(
    matchup &&
      matchup.a.model &&
      matchup.b.model &&
      reveal.kind === "reveal" &&
      reveal.matchupId === matchup.id &&
      reveal.startedAt != null,
  );
  const revealAction: RevealAction | null = reveal.kind === "reveal" ? reveal.action : null;
  const matchupHasBuildA = Boolean(matchup?.a.build);
  const matchupHasBuildB = Boolean(matchup?.b.build);
  const sideStateMatchupId = sideLoadState?.matchupId ?? null;
  const sideStatePhaseA = sideLoadState?.a ?? "idle";
  const sideStatePhaseB = sideLoadState?.b ?? "idle";

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  useEffect(() => {
    transitioningStateRef.current = transitioning;
  }, [transitioning]);

  useEffect(() => {
    revealRef.current = reveal;
  }, [reveal]);

  useEffect(() => {
    sideLoadStateRef.current = sideLoadState;
  }, [sideLoadState]);

  useEffect(() => {
    viewerReadyRef.current = viewerReady;
  }, [viewerReady]);

  useEffect(() => {
    setPromptDialogOpen(false);
    autoFullHydrationRetriesRef.current.clear();
    for (const key of autoFullHydrationRetryTimersRef.current.keys()) {
      clearAutoFullHydrationRetryTimer(key);
    }
  }, [clearAutoFullHydrationRetryTimer, matchup?.id]);

  useEffect(() => {
    // New matchup should always start at Build A on mobile.
    programmaticMobileScrollRef.current = null;
    setMobileBuildView("a");
    const el = cardsScrollRef.current;
    if (!el) return;
    el.scrollTo({ left: 0, behavior: "auto" });
  }, [matchup?.id]);

  useEffect(() => {
    if (!matchup) {
      setSideLoadState((prev) => (prev === null ? prev : null));
      setViewerReady((prev) => (prev === null ? prev : null));
      return;
    }
    setSideLoadState((prev) => {
      if (prev?.matchupId === matchup.id) return prev;
      return {
        matchupId: matchup.id,
        a: matchup.a.build ? "idle" : "loading-initial",
        b: matchup.b.build ? "idle" : "loading-initial",
        aOverlayVisible: false,
        bOverlayVisible: false,
        aProgress: null,
        bProgress: null,
        aError: null,
        bError: null,
      };
    });

    setViewerReady((prev) => {
      if (prev?.matchupId === matchup.id) return prev;
      return { matchupId: matchup.id, a: false, b: false };
    });
  }, [matchup]);

  useEffect(() => {
    if (!promptDialogOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPromptDialogOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      const row = promptRowRef.current;
      if (row && e.target instanceof Node && !row.contains(e.target)) {
        setPromptDialogOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [promptDialogOpen]);

  useEffect(() => {
    setPromptDialogOpen(false);
  }, [matchup?.id]);

  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const sync = () => setIsCoarsePointer(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    return () => {
      if (voteConfirmTimerRef.current != null) {
        window.clearTimeout(voteConfirmTimerRef.current);
      }
      if (voteWarningTimerRef.current != null) {
        window.clearTimeout(voteWarningTimerRef.current);
      }
    };
  }, []);

  function clearAutoAdvance() {
    if (autoAdvanceTimeoutRef.current != null) {
      window.clearTimeout(autoAdvanceTimeoutRef.current);
      autoAdvanceTimeoutRef.current = null;
    }
  }

  function clearStuckAutoSkip() {
    if (stuckAutoSkipTimeoutRef.current != null) {
      window.clearTimeout(stuckAutoSkipTimeoutRef.current);
      stuckAutoSkipTimeoutRef.current = null;
    }
  }

  useEffect(() => {
    const el = cardsScrollRef.current;
    if (!el) return;

    const sync = () => {
      const programmaticScroll = programmaticMobileScrollRef.current;
      if (programmaticScroll && performance.now() < programmaticScroll.until) {
        setMobileBuildView(programmaticScroll.side);
        return;
      }
      programmaticMobileScrollRef.current = null;
      const max = Math.max(0, el.scrollWidth - el.clientWidth);
      if (max <= 0) {
        setMobileBuildView("a");
        return;
      }
      setMobileBuildView(el.scrollLeft >= max / 2 ? "b" : "a");
    };

    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);

    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [matchup?.id]);

  const scrollToMobileBuild = useCallback((side: "a" | "b", behavior: ScrollBehavior = "smooth") => {
    const el = cardsScrollRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const left = side === "a" ? 0 : max;
    programmaticMobileScrollRef.current =
      behavior === "smooth" ? { side, until: performance.now() + 420 } : null;
    setMobileBuildView(side);
    el.scrollTo({ left, behavior });
  }, []);

  function sleepMs(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  const cacheHydratedBuild = useCallback((ref: ArenaBuildRef, entry: CachedHydratedBuild) => {
    const byteWeight = estimateCachedHydratedBuildBytes(entry);
    const maxEntryBytes = getPositiveByteLimit(CLIENT_BUILD_CACHE_MAX_EST_BYTES, 60_000_000);
    if (!Number.isFinite(byteWeight) || byteWeight <= 0 || byteWeight > maxEntryBytes) {
      return;
    }

    const cache = hydratedBuildCacheRef.current;
    const weights = hydratedBuildCacheWeightsRef.current;
    const key = getHydratedBuildCacheKey(ref);
    if (cache.has(key)) {
      cache.delete(key);
      hydratedBuildCacheBytesRef.current = Math.max(
        0,
        hydratedBuildCacheBytesRef.current - Math.max(0, weights.get(key) ?? 0),
      );
      weights.delete(key);
    }
    cache.set(key, entry);
    weights.set(key, byteWeight);
    hydratedBuildCacheBytesRef.current += byteWeight;

    const maxEntries =
      Number.isFinite(CLIENT_BUILD_CACHE_MAX_ENTRIES) && CLIENT_BUILD_CACHE_MAX_ENTRIES > 0
        ? CLIENT_BUILD_CACHE_MAX_ENTRIES
        : 8;
    const maxTotalBytes = getPositiveByteLimit(CLIENT_BUILD_CACHE_MAX_TOTAL_EST_BYTES, 90_000_000);
    // keep hidden hydrated builds from piling up behind the current cards
    while (cache.size > maxEntries || hydratedBuildCacheBytesRef.current > maxTotalBytes) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      hydratedBuildCacheBytesRef.current = Math.max(
        0,
        hydratedBuildCacheBytesRef.current - Math.max(0, weights.get(oldest) ?? 0),
      );
      cache.delete(oldest);
      weights.delete(oldest);
    }
  }, []);

  const readHydratedBuildFromCache = useCallback((ref: ArenaBuildRef): CachedHydratedBuild | null => {
    const cache = hydratedBuildCacheRef.current;
    const touch = (key: string) => {
      const hit = cache.get(key) ?? null;
      if (!hit) return null;
      const byteWeight = hydratedBuildCacheWeightsRef.current.get(key);
      cache.delete(key);
      cache.set(key, hit);
      if (byteWeight != null) {
        hydratedBuildCacheWeightsRef.current.delete(key);
        hydratedBuildCacheWeightsRef.current.set(key, byteWeight);
      }
      return hit;
    };

    const exactKey = getHydratedBuildCacheKey(ref);
    const exact = touch(exactKey);
    if (exact) return exact;

    if (ref.variant === "preview") {
      const fullKey = getHydratedBuildCacheKey({ ...ref, variant: "full" });
      return touch(fullKey);
    }

    return null;
  }, []);

  const applyCachedBuildsToMatchup = useCallback(
    (matchupValue: ArenaMatchup): ArenaMatchup => {
      let hydrated = matchupValue;

	      for (const side of ["a", "b"] as const) {
	        const lane = hydrated[side];
	        if (lane.build) {
	          const preferredRef =
	            laneNeedsFullHydration(lane)
	              ? (lane.previewRef ?? lane.buildRef)
	              : (lane.buildRef ?? lane.previewRef);
	          if (preferredRef) {
	            cacheHydratedBuild(preferredRef, {
	              build: lane.build,
              serverValidated: Boolean(lane.serverValidated),
              variant: preferredRef.variant,
              buildLoadHints: lane.buildLoadHints,
            });
          }
          continue;
        }

        const ref = getInitialHydrateRef(hydrated, side);
        if (!ref) continue;
        const cached = readHydratedBuildFromCache(ref);
        if (!cached) continue;
        hydrated = withHydratedBuild(
          hydrated,
          side,
          cached.build,
          cached.serverValidated,
          cached.variant,
          ref,
          cached.buildLoadHints,
        );
      }

      return hydrated;
    },
    [cacheHydratedBuild, readHydratedBuildFromCache],
  );

  const abortFullHydrations = useCallback((matchupId?: string) => {
    for (const [key, controller] of fullHydrationControllersRef.current) {
      if (matchupId && !key.startsWith(`${matchupId}:`)) continue;
      controller.abort();
      fullHydrationControllersRef.current.delete(key);
    }
  }, []);

  const abortInitialHydrations = useCallback((matchupId?: string) => {
    for (const [key, controller] of initialHydrationControllersRef.current) {
      if (matchupId && key !== matchupId) continue;
      controller.abort();
      initialHydrationControllersRef.current.delete(key);
    }
  }, []);

  const abortFullPrefetches = useCallback((matchupId?: string) => {
    for (const [key, entry] of fullBuildPrefetchRef.current) {
      if (matchupId && entry.matchupId !== matchupId) continue;
      entry.controller.abort();
      fullBuildPrefetchRef.current.delete(key);
    }
  }, []);

  const abortFullPremeshedMeshes = useCallback((matchupId?: string) => {
    for (const [key, entry] of premeshedFullMeshRef.current) {
      if (matchupId && entry.matchupId !== matchupId) continue;
      entry.controller.abort();
      premeshedFullMeshRef.current.delete(key);
    }
  }, []);

  const getLanePremeshedPayloadPromise = useCallback(
    (matchupId: string, side: "a" | "b", lane: ArenaMatchupLane): Promise<VoxelMeshPayload> | null => {
      if (!lane.build || getLaneHydratedVariant(lane) !== "full") return null;
      const key = getArenaPremeshedMeshKey(matchupId, side, "full");
      return claimArenaPremesh(premeshedFullMeshRef.current, key);
    },
    [],
  );

  const consumeLanePremeshedPayload = useCallback(
    (matchupId: string, side: "a" | "b", promise: Promise<VoxelMeshPayload>) => {
      const key = getArenaPremeshedMeshKey(matchupId, side, "full");
      if (premeshedFullMeshRef.current.get(key)?.promise === promise) {
        premeshedFullMeshRef.current.delete(key);
      }
    },
    [],
  );

  const hydrateMatchupSide = useCallback(async (
    matchupValue: ArenaMatchup,
    side: "a" | "b",
    target: "initial" | "full" = "full",
    opts?: { signal?: AbortSignal; silent?: boolean },
  ) => {
    const lane = matchupValue[side];
    const ref = target === "initial" ? getInitialHydrateRef(matchupValue, side) : (lane.buildRef ?? null);
    if (!ref) return;
    if (target === "initial" && lane.build) return;
    if (target === "full" && lane.buildLoadHints?.initialVariant === "full" && lane.build) return;

    const cached = readHydratedBuildFromCache(ref);
    if (cached) {
      markViewerLaneNotReady(matchupValue.id, side);
      setState((prev) => {
        if (prev.kind !== "ready") return prev;
        if (prev.matchup.id !== matchupValue.id) return prev;
        return {
          kind: "ready",
          matchup: withHydratedBuild(
            prev.matchup,
            side,
            cached.build,
            cached.serverValidated,
            cached.variant,
            ref,
            cached.buildLoadHints,
          ),
        };
      });
      setLaneLoadProgress(matchupValue.id, side, {
        receivedBlocks: voxelBuildBlockCount(cached.build),
        totalBlocks: voxelBuildBlockCount(cached.build),
      });
      setLaneLoadError(matchupValue.id, side, null);
      if (cached.variant === "full") {
        clearAutoFullHydrationRetry(getAutoFullHydrationFailureKey(matchupValue.id, side, ref));
      }
      setLaneLoadPhase(matchupValue.id, side, "idle");
      setLaneOverlayVisible(matchupValue.id, side, false);
      return;
    }

    const key = `${matchupValue.id}:${side}:${target}:${ref.variant}:${ref.buildId}:${ref.checksum ?? "none"}`;
    if (hydrateInFlightRef.current.has(key)) return;
    hydrateInFlightRef.current.add(key);
    const fullAbortKey = target === "full" ? `${matchupValue.id}:${side}` : null;
    let ownedFullController: AbortController | null = null;
    let effectiveSignal = opts?.signal;
    if (fullAbortKey && !effectiveSignal) {
      fullHydrationControllersRef.current.get(fullAbortKey)?.abort();
      ownedFullController = new AbortController();
      fullHydrationControllersRef.current.set(fullAbortKey, ownedFullController);
      effectiveSignal = ownedFullController.signal;
    }
    setLaneLoadPhase(matchupValue.id, side, target === "full" ? "loading-full" : "loading-initial");
    setLaneLoadProgress(matchupValue.id, side, { receivedBlocks: 0, totalBlocks: null });

    let overlayTimer: number | null = null;
    const showOverlayImmediately =
      target === "full" ||
      isHeavyRetrievalDeliveryClass(getHydrationDeliveryClass(lane.buildLoadHints, target)) ||
      !Number.isFinite(INITIAL_RETRIEVAL_OVERLAY_DELAY_MS) ||
      INITIAL_RETRIEVAL_OVERLAY_DELAY_MS <= 0;
    if (showOverlayImmediately) {
      setLaneOverlayVisible(matchupValue.id, side, true);
    } else {
      setLaneOverlayVisible(matchupValue.id, side, false);
      overlayTimer = window.setTimeout(() => {
        setLaneOverlayVisible(matchupValue.id, side, true);
      }, INITIAL_RETRIEVAL_OVERLAY_DELAY_MS);
    }

    const deliveryClass = getHydrationDeliveryClass(lane.buildLoadHints, target);
    const PROGRESS_UI_MIN_MS = target === "full" ? 300 : 90;
    let lastProgressUiAt = 0;

    const applyProgressiveBuild = (
      progressiveBuild: ArenaMatchup["a"]["build"],
      progress: BuildStreamProgress,
    ) => {
      const now = performance.now();
      const reachedComplete =
        progress.totalBlocks != null && progress.receivedBlocks >= progress.totalBlocks;
      const shouldReportProgress = reachedComplete || now - lastProgressUiAt >= PROGRESS_UI_MIN_MS;
      if (shouldReportProgress) {
        lastProgressUiAt = now;
        setLaneLoadProgress(matchupValue.id, side, {
          receivedBlocks: progress.receivedBlocks,
          totalBlocks: progress.totalBlocks,
        });
        // Show the blocks that have arrived instead of an empty frame. The
        // viewer rebuilds from whatever it is given, and readiness stays tied
        // to the expected full count, so this changes what is on screen during
        // hydration and never when a vote becomes possible.
        if (progressiveBuild && !reachedComplete) {
          setLaneProgressiveBuild(matchupValue.id, side, progressiveBuild);
        }
      }
      // the final payload still flips voting state
    };

    let unsubscribePrefetchProgress: (() => void) | null = null;
    try {
      const hydrationStartedAt = performance.now();
      let payload: BuildVariantResponse;
      const prefetchKey = target === "full" ? getHydratedBuildCacheKey(ref) : null;
      const prefetchEntry = prefetchKey ? fullBuildPrefetchRef.current.get(prefetchKey) ?? null : null;
      const prefetched = prefetchEntry?.promise ?? null;
      if (prefetched && prefetchEntry) {
        // show progress for reveal-time prefetches once they become visible
        const applyPrefetchProgress = (progress: BuildStreamProgress) => {
          applyProgressiveBuild(null, progress);
        };
        if (prefetchEntry.progress) {
          applyPrefetchProgress(prefetchEntry.progress);
        }
        prefetchEntry.listeners.add(applyPrefetchProgress);
        unsubscribePrefetchProgress = () => {
          prefetchEntry.listeners.delete(applyPrefetchProgress);
        };
        payload = await prefetched;
      } else {
        // stream classes stay on stream paths
        const allowSnapshotFallback = shouldHydrateViaSnapshot(deliveryClass);
        const allowLiveFallback = deliveryClass !== "stream-artifact";
        if (shouldHydrateViaSnapshot(deliveryClass)) {
          try {
            payload = await fetchBuildVariantSnapshot(ref, effectiveSignal);
          } catch {
            payload = await fetchBuildVariantStream(ref, {
              signal: effectiveSignal,
              onProgress: applyProgressiveBuild,
              allowSnapshotFallback,
              allowLiveFallback,
            });
          }
        } else {
          payload = await fetchBuildVariantStream(ref, {
            signal: effectiveSignal,
            onProgress: applyProgressiveBuild,
            allowSnapshotFallback,
            allowLiveFallback,
          });
        }
      }
      const hydrationMs = performance.now() - hydrationStartedAt;
      const resolvedRef: ArenaBuildRef = {
        buildId: payload.buildId === ref.buildId ? payload.buildId : ref.buildId,
        variant: payload.variant ?? ref.variant,
        checksum: payload.checksum ?? ref.checksum ?? null,
      };
      markViewerLaneNotReady(matchupValue.id, side);
      setState((prev) => {
        if (prev.kind !== "ready") return prev;
        if (prev.matchup.id !== matchupValue.id) return prev;
        return {
          kind: "ready",
          matchup: withHydratedBuild(
            prev.matchup,
            side,
            payload.voxelBuild,
            payload.serverValidated,
            payload.variant,
            resolvedRef,
            payload.buildLoadHints,
          ),
        };
      });
      if (payload.voxelBuild) {
        cacheHydratedBuild(resolvedRef, {
          build: payload.voxelBuild,
          serverValidated: payload.serverValidated,
          variant: resolvedRef.variant,
          buildLoadHints: payload.buildLoadHints,
        });
        setLaneLoadProgress(matchupValue.id, side, {
          receivedBlocks: voxelBuildBlockCount(payload.voxelBuild),
          totalBlocks: voxelBuildBlockCount(payload.voxelBuild),
        });
        setLaneLoadError(matchupValue.id, side, null);
      }
      if (resolvedRef.variant === "full") {
        clearAutoFullHydrationRetry(getAutoFullHydrationFailureKey(matchupValue.id, side, ref));
        clearAutoFullHydrationRetry(getAutoFullHydrationFailureKey(matchupValue.id, side, resolvedRef));
      }
      if (
        target === "full" &&
        Number.isFinite(hydrationMs) &&
        hydrationMs >= FULL_HYDRATION_SLOW_MS
      ) {
        trackEvent("arena_full_hydration_slow", {
          ms: Math.round(hydrationMs),
          deliveryClass: lane.buildLoadHints?.deliveryClass ?? "unknown",
          initialVariant: lane.buildLoadHints?.initialVariant ?? "unknown",
          side,
        });
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      if (target === "full") {
        registerAutoFullHydrationFailure(getAutoFullHydrationFailureKey(matchupValue.id, side, ref));
        setLaneLoadError(matchupValue.id, side, "Full build stalled.");
      }
      if (target === "initial" || !lane.build) {
        setLaneLoadError(matchupValue.id, side, "Build stalled.");
      }
      if (!opts?.silent) {
        console.warn("arena full build hydration failed", err);
      }
    } finally {
      unsubscribePrefetchProgress?.();
      if (overlayTimer != null) window.clearTimeout(overlayTimer);
      hydrateInFlightRef.current.delete(key);
      if (
        fullAbortKey &&
        ownedFullController &&
        fullHydrationControllersRef.current.get(fullAbortKey) === ownedFullController
      ) {
        fullHydrationControllersRef.current.delete(fullAbortKey);
      }
      setLaneOverlayVisible(matchupValue.id, side, false);
      setLaneLoadProgress(matchupValue.id, side, null);
      setLaneLoadPhase(matchupValue.id, side, "idle");
    }
  }, [
    cacheHydratedBuild,
    clearAutoFullHydrationRetry,
    setLaneProgressiveBuild,
    markViewerLaneNotReady,
    readHydratedBuildFromCache,
    registerAutoFullHydrationFailure,
    setLaneLoadPhase,
    setLaneLoadError,
    setLaneLoadProgress,
    setLaneOverlayVisible,
  ]);

  const requestFullLaneDetail = useCallback(
    (side: "a" | "b") => {
      const current =
        stateRef.current.kind === "ready" ? stateRef.current.matchup : null;
      if (!current) return;
      if (!laneNeedsFullHydration(current[side])) return;
      const ref = current[side].buildRef;
      if (ref) {
        clearAutoFullHydrationRetry(getAutoFullHydrationFailureKey(current.id, side, ref));
      }
      void hydrateMatchupSide(current, side, "full", { silent: true });
    },
    [clearAutoFullHydrationRetry, hydrateMatchupSide],
  );

  const retryLaneBuild = useCallback(
    (side: "a" | "b") => {
      const current = stateRef.current.kind === "ready" ? stateRef.current.matchup : null;
      if (!current) return;
      const lane = current[side];
      if (lane.build && laneNeedsFullHydration(lane)) {
        const ref = lane.buildRef;
        if (ref) {
          clearAutoFullHydrationRetry(getAutoFullHydrationFailureKey(current.id, side, ref));
        }
        void hydrateMatchupSide(current, side, "full", { silent: false });
        return;
      }
      if (!lane.build) {
        void hydrateMatchupSide(current, side, "initial", { silent: false });
      }
    },
    [clearAutoFullHydrationRetry, hydrateMatchupSide],
  );

  const prefetchFullLaneForVote = useCallback(
    (matchupValue: ArenaMatchup, side: "a" | "b") => {
      const lane = matchupValue[side];
      const ref = lane.buildRef;
      if (!ref || !laneExpectsFullHydration(lane)) return;

      const cached = readHydratedBuildFromCache(ref);
      if (cached?.variant === "full") {
        return;
      }
      if (!shouldPrefetchFullLane(lane)) return;

      const cacheKey = getHydratedBuildCacheKey(ref);
      if (fullBuildPrefetchRef.current.has(cacheKey)) return;
      // keep json parse + block arrays from stacking across cards
      const maxInFlight =
        Number.isFinite(CLIENT_FULL_PREFETCH_MAX_IN_FLIGHT)
          ? Math.floor(CLIENT_FULL_PREFETCH_MAX_IN_FLIGHT)
          : 2;
      if (maxInFlight <= 0) return;
      if (fullBuildPrefetchRef.current.size >= maxInFlight) return;
      const controller = new AbortController();
      const prefetchEntry: FullBuildPrefetch = {
        matchupId: matchupValue.id,
        controller,
        promise: null,
        progress: null,
        listeners: new Set(),
      };
      const emitPrefetchProgress = (progress: BuildStreamProgress) => {
        prefetchEntry.progress = progress;
        for (const listener of prefetchEntry.listeners) {
          listener(progress);
        }
      };

      const promise = (async () => {
        const deliveryClass = getHydrationDeliveryClass(lane.buildLoadHints, "full");
        const allowSnapshotFallback = shouldHydrateViaSnapshot(deliveryClass);
        const allowLiveFallback = deliveryClass !== "stream-artifact";
        const payload = shouldHydrateViaSnapshot(deliveryClass)
          ? await fetchBuildVariantSnapshot(ref, controller.signal, SNAPSHOT_FETCH_TIMEOUT_MS, {
              purpose: "prefetch",
            }).catch(() =>
              fetchBuildVariantStream(ref, {
                signal: controller.signal,
                allowSnapshotFallback,
                allowLiveFallback,
                purpose: "prefetch",
                onProgress: (_build, progress) => emitPrefetchProgress(progress),
              }),
            )
          : await fetchBuildVariantStream(ref, {
              signal: controller.signal,
              allowSnapshotFallback,
              allowLiveFallback,
              purpose: "prefetch",
              onProgress: (_build, progress) => emitPrefetchProgress(progress),
            });
        const resolvedRef: ArenaBuildRef = {
          buildId: payload.buildId === ref.buildId ? payload.buildId : ref.buildId,
          variant: payload.variant ?? ref.variant,
          checksum: payload.checksum ?? ref.checksum ?? null,
        };
        if (!payload.voxelBuild) {
          throw new Error("Prefetched build response was empty");
        }
        const entry: CachedHydratedBuild = {
          build: payload.voxelBuild,
          serverValidated: payload.serverValidated,
          variant: resolvedRef.variant,
          buildLoadHints: payload.buildLoadHints,
        };
        cacheHydratedBuild(resolvedRef, entry);

        const blockCount = voxelBuildBlockCount(payload.voxelBuild);
        if (blockCount > 0 && blockCount <= ARENA_PREMESH_MAX_BLOCK_COUNT) {
          const warmKey = getArenaPremeshedMeshKey(matchupValue.id, side, "full");
          if (!premeshedFullMeshRef.current.has(warmKey)) {
            const warmController = new AbortController();
            const startWarm = async (): Promise<VoxelMeshPayload> => {
              const warmEntry = premeshedFullMeshRef.current.get(warmKey);
              if (!warmEntry || warmController.signal.aborted) {
                throw new DOMException("Aborted", "AbortError");
              }
              warmEntry.started = true;
              const { payload: meshPayload } = await createVoxelMeshPayloadInWorker(
                payload.voxelBuild!,
                getPalette("simple"),
                { signal: warmController.signal, blockLimit: blockCount },
              );
              return meshPayload;
            };

            const sequencedPromise = inFlightWarmPromiseRef.current.then(startWarm, startWarm);
            inFlightWarmPromiseRef.current = sequencedPromise.then(
              () => undefined,
              () => undefined,
            );
            premeshedFullMeshRef.current.set(warmKey, {
              matchupId: matchupValue.id,
              promise: sequencedPromise,
              controller: warmController,
              started: false,
            });
          }
        }

        return payload;
      })();

      prefetchEntry.promise = promise;
      fullBuildPrefetchRef.current.set(cacheKey, prefetchEntry);
      void promise
        .catch(() => undefined)
        .finally(() => {
          prefetchEntry.listeners.clear();
          if (fullBuildPrefetchRef.current.get(cacheKey)?.promise === promise) {
            fullBuildPrefetchRef.current.delete(cacheKey);
          }
        });
    },
    [cacheHydratedBuild, readHydratedBuildFromCache],
  );

  const prefetchMatchupBuilds = useCallback(
    (matchupValue: ArenaMatchup) => {
      for (const side of ["a", "b"] as const) {
        const lane = matchupValue[side];
        if (shouldPrefetchInitialBuild(lane.buildLoadHints)) {
          void hydrateMatchupSide(matchupValue, side, "initial", { silent: true });
        }
        prefetchFullLaneForVote(matchupValue, side);
      }
    },
    [hydrateMatchupSide, prefetchFullLaneForVote],
  );

  useEffect(() => {
    return () => {
      if (matchup?.id) abortFullHydrations(matchup.id);
      if (matchup?.id) abortInitialHydrations(matchup.id);
      if (matchup?.id) abortFullPrefetches(matchup.id);
      if (matchup?.id) abortFullPremeshedMeshes(matchup.id);
    };
  }, [abortFullHydrations, abortFullPrefetches, abortFullPremeshedMeshes, abortInitialHydrations, matchup?.id]);

  useEffect(() => {
    return () => {
      abortFullPremeshedMeshes();
    };
  }, [abortFullPremeshedMeshes]);

  useEffect(() => {
    if (reveal.kind !== "reveal") return;
    const id = window.setInterval(() => forceTick((t) => t + 1), 120);
    return () => window.clearInterval(id);
  }, [reveal.kind, revealModels]);

  useEffect(() => {
    const retryTimers = autoFullHydrationRetryTimersRef.current;
    return () => {
      clearAutoAdvance();
      clearStuckAutoSkip();
      for (const timer of retryTimers.values()) {
        window.clearTimeout(timer);
      }
      retryTimers.clear();
    };
  }, []);

  useEffect(() => {
    // AbortController lets us actually cancel the in-flight fetchMatchup
    // when reloadToken bumps (retry click). /api/arena/matchup still
    // creates a matchup row server-side, so silently ignoring a stale
    // response would burn matchups with no vote signal. Aborting
    // short-circuits the network round-trip so at least the response body
    // parse + any follow-up is cancelled.
    const controller = new AbortController();
    let cancelled = false;
    setState({ kind: "loading" });
    setSlowInitialLoad(false);
    // nudge after 5s if the initial matchup is still loading so users know
    // the delay is server-side, not their browser
    const slowTimer = setTimeout(() => {
      if (!cancelled) setSlowInitialLoad(true);
    }, 5_000);
    fetchMatchup(undefined, controller.signal)
      .then((m) => {
        if (cancelled) return;
        setState({ kind: "ready", matchup: applyCachedBuildsToMatchup(m) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load matchup",
        });
      })
      .finally(() => {
        if (!cancelled) {
          setRetrying(false);
          setSlowInitialLoad(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(slowTimer);
    };
  }, [applyCachedBuildsToMatchup, reloadToken]);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    setReloadToken((n) => n + 1);
  }, []);

  useEffect(() => {
    const current =
      stateRef.current.kind === "ready" ? stateRef.current.matchup : null;
    if (!current) return;
    const hydrateSides = (["a", "b"] as const)
      .filter((side) => !current[side].build)
      .filter((side) => Boolean(getInitialHydrateRef(current, side)));

    if (hydrateSides.length === 0) return;

    abortInitialHydrations(current.id);
    const controller = new AbortController();
    const initialHydrationControllers = initialHydrationControllersRef.current;
    initialHydrationControllers.set(current.id, controller);

    for (const side of hydrateSides) {
      void hydrateMatchupSide(current, side, "initial", { signal: controller.signal, silent: true });
    }

    return () => {
      controller.abort();
      if (initialHydrationControllers.get(current.id) === controller) {
        initialHydrationControllers.delete(current.id);
      }
    };
  }, [abortInitialHydrations, hydrateMatchupSide, matchup?.id]);

  // Voting requires full builds, so preview lanes keep retrying full hydration
  // with capped backoff instead of getting stuck on a transient artifact miss.
  useEffect(() => {
    const current =
      stateRef.current.kind === "ready" ? stateRef.current.matchup : null;
    if (!current) return;

    for (const side of ["a", "b"] as const) {
      const lane = current[side];
      if (!lane.build) continue;
      if (!laneShouldAutoUpgradeToFull(lane)) continue;
      if (!lane.buildRef) continue;
      const retryKey = getAutoFullHydrationFailureKey(current.id, side, lane.buildRef);
      const retry = autoFullHydrationRetriesRef.current.get(retryKey);
      if (retry?.exhausted) continue;
      if (retry) {
        const waitMs = retry.nextRetryAt - Date.now();
        if (waitMs > 0) {
          scheduleAutoFullHydrationRetryWake(retryKey, waitMs);
          continue;
        }
      }

      // Wait until the preview lane is idle so we don't compete with initial hydration.
      const phase = side === "a" ? sideStatePhaseA : sideStatePhaseB;
      if (sideStateMatchupId === current.id && phase !== "idle") continue;

      // No AbortController here: this effect depends on the load phases that hydration mutates.
      // Aborting in cleanup would immediately cancel the request, creating a retry loop + 429s.
      void hydrateMatchupSide(current, side, "full", { silent: true });
    }
  }, [
    hydrateMatchupSide,
    matchup?.id,
    fullHydrationRetryTick,
    scheduleAutoFullHydrationRetryWake,
    sideStateMatchupId,
    sideStatePhaseA,
    sideStatePhaseB,
    matchupHasBuildA,
    matchupHasBuildB,
    matchup?.a.buildLoadHints?.initialVariant,
    matchup?.b.buildLoadHints?.initialVariant,
  ]);

  useEffect(() => {
    clearStuckAutoSkip();
    if (!matchup) return;
    if (!isMatchupInitialBuildLoading(matchup, sideLoadState)) return;
    if (!Number.isFinite(BUILD_STUCK_AUTOSKIP_MS) || BUILD_STUCK_AUTOSKIP_MS <= 0) return;
    if (submittingRef.current) return;

    stuckAutoSkipTimeoutRef.current = window.setTimeout(() => {
      const current = stateRef.current;
      if (current.kind !== "ready") return;
      if (current.matchup.id !== matchup.id) return;
      if (!isMatchupInitialBuildLoading(current.matchup, sideLoadStateRef.current)) return;
      if (submittingRef.current) return;
      void handleSkipRef.current();
    }, BUILD_STUCK_AUTOSKIP_MS);

    return () => {
      clearStuckAutoSkip();
    };
  }, [matchup, sideLoadState]);

  const revealVerdict =
    revealAction === "SKIP"
      ? "Skipped"
      : revealAction === "TIE"
        ? "Tie"
        : revealAction === "BOTH_BAD"
          ? "Both bad"
          : null;

  const revealMeta = (() => {
    if (!matchup || reveal.kind !== "reveal" || reveal.matchupId !== matchup.id) {
      return {
        visible: false,
        pending: false,
        secondsLeft: 0,
        progress: 0,
        nextReady: false,
        waitingForNext: false,
      };
    }
    if (reveal.startedAt == null || reveal.advanceAt == null) {
      return {
        visible: true,
        pending: true,
        secondsLeft: 0,
        progress: 0,
        nextReady: false,
        waitingForNext: false,
      };
    }

    const totalMs = Math.max(1, reveal.advanceAt - reveal.startedAt);
    const remainingMs = Math.max(0, reveal.advanceAt - Date.now());
    const timedProgress = Math.min(1, Math.max(0, 1 - remainingMs / totalMs));
    const secondsLeft = remainingMs / 1000;
    const nextReady = Boolean(reveal.next);
    const waitingForNext = !nextReady && remainingMs <= 0;
    const progress = nextReady ? timedProgress : Math.min(0.94, timedProgress);
    return { visible: true, pending: false, secondsLeft, progress, nextReady, waitingForNext };
  })();

  async function advanceToNext(matchupId: string, next: ArenaMatchup) {
    const current = revealRef.current;
    if (current.kind !== "reveal" || current.matchupId !== matchupId) return;
    if (transitionRef.current) return;

    transitionRef.current = true;
    setTransitioning(true);
    clearAutoAdvance();
    advanceNowRequestedAtRef.current = null;

    await sleepMs(TRANSITION_OUT_MS);

    const still = revealRef.current;
    if (still.kind !== "reveal" || still.matchupId !== matchupId) {
      transitionRef.current = false;
      setTransitioning(false);
      return;
    }

    setState({ kind: "ready", matchup: applyCachedBuildsToMatchup(next) });
    abortFullHydrations(matchupId);
    abortInitialHydrations(matchupId);
    abortFullPrefetches(matchupId);
    abortFullPremeshedMeshes(matchupId);
    setReveal({ kind: "none" });
    setSubmitting(false);

    // Let the new matchup mount at 0 opacity, then fade back in.
    requestAnimationFrame(() => {
      transitionRef.current = false;
      setTransitioning(false);
    });
  }

  const requestAdvanceNow = useCallback((matchupId: string) => {
    const current = revealRef.current;
    if (current.kind !== "reveal" || current.matchupId !== matchupId || current.advanceAt == null) return;
    const now = Date.now();
    advanceNowRequestedAtRef.current = now;
    setReveal((prev) => {
      if (prev.kind !== "reveal" || prev.matchupId !== matchupId || prev.advanceAt == null) return prev;
      // Clamp so the timer UI switches to "Loading next…" immediately.
      return { ...prev, advanceAt: Math.min(prev.advanceAt, now) };
    });
    if (current.next) {
      void advanceToNextRef.current(matchupId, current.next);
    } else {
      void loadNextMatchupRef.current(matchupId, Math.min(current.advanceAt, now));
    }
  }, []);

  function scheduleAutoAdvance(matchupId: string, advanceAt: number, next: ArenaMatchup) {
    clearAutoAdvance();
    const remaining = advanceAt - Date.now();
    const delay = Math.max(0, remaining);
    autoAdvanceTimeoutRef.current = window.setTimeout(() => {
      void advanceToNext(matchupId, next);
    }, delay);
  }

  function flashVoteConfirm(target: VoteConfirmTarget) {
    setVoteConfirming(target);
    if (voteConfirmTimerRef.current != null) {
      window.clearTimeout(voteConfirmTimerRef.current);
    }
    voteConfirmTimerRef.current = window.setTimeout(() => {
      setVoteConfirming(null);
      voteConfirmTimerRef.current = null;
    }, 620);
  }

  function flashVoteWarning(message: string) {
    setVoteWarning(message);
    if (voteWarningTimerRef.current != null) {
      window.clearTimeout(voteWarningTimerRef.current);
    }
    voteWarningTimerRef.current = window.setTimeout(() => {
      setVoteWarning(null);
      voteWarningTimerRef.current = null;
    }, 6000);
  }

  function beginReveal(matchupId: string, action: RevealAction) {
    setReveal({
      kind: "reveal",
      matchupId,
      action,
      startedAt: null,
      advanceAt: null,
      next: null,
    });
  }

  function completeReveal(matchupId: string, response: ArenaVoteResponse, durationMs: number): number {
    setState((prev) =>
      prev.kind === "ready" && prev.matchup.id === matchupId
        ? {
            kind: "ready",
            matchup: {
              ...prev.matchup,
              a: { ...prev.matchup.a, model: response.reveal.a },
              b: { ...prev.matchup.b, model: response.reveal.b },
            },
          }
        : prev,
    );
    const startedAt = Date.now();
    const advanceAt = startedAt + durationMs;
    setReveal((prev) =>
      prev.kind === "reveal" && prev.matchupId === matchupId
        ? { ...prev, startedAt, advanceAt }
        : prev,
    );
    return advanceAt;
  }

  function queueNextMatchup(matchupId: string, advanceAt: number, fetchedNext: ArenaMatchup) {
    const next = applyCachedBuildsToMatchup(fetchedNext);
    prefetchMatchupBuilds(next);
    const stillRevealing = revealRef.current.kind === "reveal" && revealRef.current.matchupId === matchupId;
    if (stillRevealing) {
      const requestedAt = advanceNowRequestedAtRef.current;
      const effectiveAdvanceAt =
        typeof requestedAt === "number" && Number.isFinite(requestedAt) ? Math.min(advanceAt, requestedAt) : advanceAt;
      setReveal((prev) =>
        prev.kind === "reveal" && prev.matchupId === matchupId
          ? { ...prev, next, advanceAt: effectiveAdvanceAt }
          : prev,
      );
      scheduleAutoAdvance(matchupId, effectiveAdvanceAt, next);
      return;
    }

    setState((prev) => {
      if (prev.kind === "ready" && prev.matchup.id !== matchupId) return prev;
      if (prev.kind === "error") return prev;
      return { kind: "ready", matchup: next };
    });
    setSubmitting(false);
  }

  async function loadNextMatchup(matchupId: string, advanceAt: number) {
    if (nextMatchupLoadingRef.current) return;
    nextMatchupLoadingRef.current = true;
    try {
      queueNextMatchup(matchupId, advanceAt, await fetchMatchup(undefined));
    } catch (err) {
      clearAutoAdvance();
      flashVoteWarning(
        err instanceof Error ? err.message : "Couldn't load the next matchup",
      );
    } finally {
      nextMatchupLoadingRef.current = false;
    }
  }

  async function handleVote(choice: VoteChoice) {
    if (!matchup || submitting) return;
    if (isMatchupVoteBlocked(matchup, sideLoadStateRef.current)) return;
    const viewer = viewerReadyRef.current;
    if (!viewer || viewer.matchupId !== matchup.id || !viewer.a || !viewer.b) return;
    flashVoteConfirm(choice);
    setSubmitting(true);
    clearAutoAdvance();
    advanceNowRequestedAtRef.current = null;
    beginReveal(matchup.id, choice);

    let advanceAt: number;
    try {
      const response = await submitArenaAction(matchup.id, choice);
      advanceAt = completeReveal(matchup.id, response, REVEAL_MS_AFTER_VOTE);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't record your vote.";
      flashVoteWarning(msg);
      setReveal({ kind: "none" });
      setSubmitting(false);
      return;
    }

    // Do not create the next matchup until the vote is durable.
    await loadNextMatchup(matchup.id, advanceAt);
  }

  async function handleSkip() {
    if (!matchup || submitting) return;
    flashVoteConfirm("SKIP");
    setSubmitting(true);
    clearAutoAdvance();
    advanceNowRequestedAtRef.current = null;
    beginReveal(matchup.id, "SKIP");
    // old hydration should not overlap the next matchup
    abortInitialHydrations(matchup.id);
    abortFullHydrations(matchup.id);
    abortFullPrefetches(matchup.id);
    abortFullPremeshedMeshes(matchup.id);

    let advanceAt: number;
    try {
      const response = await submitArenaAction(matchup.id, "SKIP");
      advanceAt = completeReveal(matchup.id, response, REVEAL_MS_AFTER_SKIP);
    } catch (err) {
      clearAutoAdvance();
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load matchup",
      });
      setReveal({ kind: "none" });
      setSubmitting(false);
      return;
    }
    await loadNextMatchup(matchup.id, advanceAt);
  }

  handleVoteRef.current = handleVote;
  handleSkipRef.current = handleSkip;
  advanceToNextRef.current = advanceToNext;
  loadNextMatchupRef.current = loadNextMatchup;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (window.innerWidth < 768) return;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isInteractiveTarget(e.target)) return;
      if (stateRef.current.kind !== "ready") return;

      const isSubmitting = submittingRef.current;
      const isTransitioning = transitioningStateRef.current || transitionRef.current;
      const currentMatchup = stateRef.current.matchup;
      const viewer = viewerReadyRef.current;
      const viewersReady =
        Boolean(viewer && viewer.matchupId === currentMatchup.id && viewer.a && viewer.b);
      const votesLocked =
        !viewersReady || isMatchupVoteBlocked(currentMatchup, sideLoadStateRef.current);

      const current = revealRef.current;
      const isRevealingCurrent =
        current.kind === "reveal" && current.matchupId === currentMatchup.id;

      if (e.code === "Digit1") {
        if (isSubmitting || isTransitioning || isRevealingCurrent || votesLocked) return;
        e.preventDefault();
        void handleVoteRef.current("A");
        return;
      }

      if (e.code === "KeyA" || e.code === "ArrowLeft") {
        if (isSubmitting || isTransitioning || isRevealingCurrent || votesLocked) return;
        e.preventDefault();
        void handleVoteRef.current("A");
        return;
      }

      if (e.code === "Digit2") {
        if (isSubmitting || isTransitioning || isRevealingCurrent || votesLocked) return;
        e.preventDefault();
        void handleVoteRef.current("B");
        return;
      }

      if (e.code === "KeyB" || e.code === "ArrowRight") {
        if (isSubmitting || isTransitioning || isRevealingCurrent || votesLocked) return;
        e.preventDefault();
        void handleVoteRef.current("B");
        return;
      }

      if (e.code === "ArrowDown" || e.code === "KeyX") {
        if (isSubmitting || isTransitioning || isRevealingCurrent || votesLocked) return;
        e.preventDefault();
        void handleVoteRef.current("BOTH_BAD");
        return;
      }

      if (e.code !== "Space" && e.code !== "ArrowUp") return;

      if (isRevealingCurrent) {
        e.preventDefault();
        if (isTransitioning) return;
        if (!current.next) {
          requestAdvanceNow(current.matchupId);
          return;
        }
        void advanceToNextRef.current(current.matchupId, current.next);
        return;
      }

      if (isSubmitting || isTransitioning) return;
      e.preventDefault();
      void handleSkipRef.current();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestAdvanceNow]);

  const promptText = matchup?.prompt.text ?? "";
  const isLongPrompt = promptText.length > 120;
  const isSideLoadActive = Boolean(sideLoadState && matchup && sideLoadState.matchupId === matchup.id);
  const laneLoadA = isSideLoadActive && sideLoadState ? sideLoadState.a : "idle";
  const laneLoadB = isSideLoadActive && sideLoadState ? sideLoadState.b : "idle";
  const laneOverlayA = isSideLoadActive && sideLoadState ? sideLoadState.aOverlayVisible : true;
  const laneOverlayB = isSideLoadActive && sideLoadState ? sideLoadState.bOverlayVisible : true;
  const laneProgressA = isSideLoadActive && sideLoadState ? sideLoadState.aProgress : null;
  const laneProgressB = isSideLoadActive && sideLoadState ? sideLoadState.bProgress : null;
  const laneErrorA = isSideLoadActive && sideLoadState ? sideLoadState.aError : null;
  const laneErrorB = isSideLoadActive && sideLoadState ? sideLoadState.bError : null;
  const viewerState =
    matchup && viewerReady && viewerReady.matchupId === matchup.id ? viewerReady : null;
  const viewerReadyA = Boolean(viewerState?.a);
  const viewerReadyB = Boolean(viewerState?.b);
  const laneNeedsFullA = Boolean(matchup && laneNeedsFullHydration(matchup.a));
  const laneNeedsFullB = Boolean(matchup && laneNeedsFullHydration(matchup.b));
  const buildAUpgradePending = laneLoadA === "loading-full";
  const buildBUpgradePending = laneLoadB === "loading-full";

  const matchupBuildLoading = Boolean(
    matchup && (isMatchupVoteBlocked(matchup, sideLoadState) || !viewerReadyA || !viewerReadyB),
  );

  useEffect(() => {
    if (!matchup) {
      matchupStagesRef.current = null;
      return;
    }
    if (!matchupStagesRef.current || matchupStagesRef.current.matchupId !== matchup.id) {
      const mode = matchupRequestModes.get(matchup.id) ?? "random";
      matchupStagesRef.current = {
        matchupId: matchup.id,
        startAt: performance.now(),
        mode,
        previewReadyReported: false,
        voteReadyReported: false,
      };
    }
  }, [matchup]);

  useEffect(() => {
    const stages = matchupStagesRef.current;
    if (!stages || !matchup || stages.matchupId !== matchup.id) return;
    const now = performance.now();
    const elapsedMs = Math.max(0, Math.round(now - stages.startAt));
    const mode = stages.mode;

    if (viewerReadyA && viewerReadyB && !stages.previewReadyReported) {
      stages.previewReadyReported = true;
      enqueueMatchupStageMetric({
        stage: "preview_ready",
        mode,
        laneABlocks: voxelBuildBlockCount(matchup.a.build),
        laneBBlocks: voxelBuildBlockCount(matchup.b.build),
        durationMs: elapsedMs,
      });
      trackEvent("arena_matchup_stage", {
        stage: "preview_ready",
        mode,
        durationMs: elapsedMs,
      });
    }

    if (!matchupBuildLoading && !stages.voteReadyReported) {
      stages.voteReadyReported = true;
      enqueueMatchupStageMetric({
        stage: "vote_ready",
        mode,
        laneABlocks: voxelBuildBlockCount(matchup.a.build),
        laneBBlocks: voxelBuildBlockCount(matchup.b.build),
        durationMs: elapsedMs,
      });
      trackEvent("arena_matchup_stage", {
        stage: "vote_ready",
        mode,
        durationMs: elapsedMs,
      });
    }
  }, [
    matchup,
    matchupBuildLoading,
    viewerReadyA,
    viewerReadyB,
  ]);

  const buildARetrieving =
    state.kind === "loading" ||
    Boolean(
	      matchup &&
	        ((!matchup.a.build && !laneErrorA) ||
	          laneLoadA === "loading-initial"),
    );
  const buildBRetrieving =
    state.kind === "loading" ||
    Boolean(
	      matchup &&
	        ((!matchup.b.build && !laneErrorB) ||
	          laneLoadB === "loading-initial"),
    );
  const buildAPlacing = Boolean(matchup && matchup.a.build && laneLoadA === "idle" && !viewerReadyA);
  const buildBPlacing = Boolean(matchup && matchup.b.build && laneLoadB === "idle" && !viewerReadyB);
  const buildALoading = buildARetrieving || buildAPlacing || buildAUpgradePending;
  const buildBLoading = buildBRetrieving || buildBPlacing || buildBUpgradePending;
  const buildALoadingMode =
    buildALoading &&
    state.kind !== "loading" &&
    !laneOverlayA &&
    !buildAPlacing &&
    !laneNeedsFullA
      ? "silent"
      : "overlay";
  const buildBLoadingMode =
    buildBLoading &&
    state.kind !== "loading" &&
    !laneOverlayB &&
    !buildBPlacing &&
    !laneNeedsFullB
      ? "silent"
      : "overlay";
  const buildAFullLoading = laneLoadA === "loading-full";
  const buildBFullLoading = laneLoadB === "loading-full";
  const buildLoadError =
    laneErrorA && laneErrorB ? "Both builds stalled." : laneErrorA || laneErrorB;
  const buildALoadingMessage = buildALoading
    ? buildAPlacing
      ? "Placing blocks…"
      : formatBuildLoadingMessage(
          buildAFullLoading || buildAUpgradePending,
          laneProgressA,
        )
    : undefined;
  const buildBLoadingMessage = buildBLoading
    ? buildBPlacing
      ? "Placing blocks…"
      : formatBuildLoadingMessage(
          buildBFullLoading || buildBUpgradePending,
          laneProgressB,
        )
    : undefined;
  const buildSwitchDisabled = state.kind !== "ready" || transitioning;

  return (
    <div id="mb-arena" className="flex flex-col gap-10 md:gap-12">
      <div className="flex flex-col gap-3">
          {/* prompt */}
          <div ref={promptRowRef} className="relative border-b border-border/70 pb-3">
            <div className="flex items-center gap-3 sm:gap-4">
              <span className="mb-eyebrow shrink-0">Prompt</span>
              <div
                className={`relative min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ellipsis text-[15px] leading-snug text-fg transition-opacity duration-150 ease-out motion-reduce:transition-none sm:text-base ${isLongPrompt ? "pr-10" : ""} ${promptDialogOpen ? "opacity-0" : "opacity-100"}`}
              >
                <AnimatedPrompt text={promptText || "Loading…"} isExpanded={false} />
                {isLongPrompt ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-0 w-14 bg-gradient-to-l from-bg to-transparent"
                  />
                ) : null}
              </div>
              {isLongPrompt ? (
                <button
                  type="button"
                  aria-expanded={promptDialogOpen}
                  className="inline-flex h-7 shrink-0 items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-fg focus-visible:text-accent focus-visible:outline-none"
                  onClick={() => setPromptDialogOpen((open) => !open)}
                >
                  <span className="hidden sm:inline">Full prompt</span>
                  <span className="sm:hidden">Full</span>
                  <svg
                    aria-hidden="true"
                    className={`mb-disclosure-chevron h-3 w-3 ${promptDialogOpen ? "is-open" : ""}`}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 6.5L8 10.5L12 6.5" />
                  </svg>
                </button>
              ) : null}
            </div>

            {/* Drops out of the prompt rule rather than pushing the viewers down:
               reflowing the canvas mid-transition costs a frame budget we do not have. */}
            {isLongPrompt ? (
              <div
                className={`mb-prompt-reveal absolute inset-x-0 top-full z-30 ${promptDialogOpen ? "is-open" : ""}`}
                aria-hidden={!promptDialogOpen}
              >
                <p className="border-b border-border bg-bg px-0 pb-4 pt-3 text-[15px] leading-relaxed text-fg/90 sm:text-base">
                  {promptText}
                </p>
              </div>
            ) : null}
          </div>

          {state.kind === "error" ? (
            <ErrorState
              error={new Error(state.message)}
              title="Couldn't load matchup"
              hint={state.message || "The site may be under heavy load. Try again in a moment."}
              onRetry={handleRetry}
              retrying={retrying}
            />
          ) : null}

          {state.kind === "loading" && slowInitialLoad ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 rounded-md bg-bg/50 px-3 py-2 text-xs text-muted ring-1 ring-border/60"
            >
              <span className="mb-progress-wait relative h-1.5 w-6 overflow-hidden rounded-full bg-border/40" aria-hidden="true" />
              <span>Taking longer than usual — MineBench may be under heavy load.</span>
            </div>
          ) : null}

          {voteWarning ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 rounded-md bg-warn/8 px-3 py-2 text-xs text-warn ring-1 ring-warn/30"
            >
              <svg
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
              <span className="min-w-0 break-words">
                Vote didn&apos;t save: {voteWarning} Try voting again.
              </span>
              <button
                type="button"
                aria-label="Dismiss"
                className="ml-auto shrink-0 text-warn/70 hover:text-warn"
                onClick={() => {
                  setVoteWarning(null);
                  if (voteWarningTimerRef.current != null) {
                    window.clearTimeout(voteWarningTimerRef.current);
                    voteWarningTimerRef.current = null;
                  }
                }}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          ) : null}

          {/* builds grid */}
          <div
            ref={cardsScrollRef}
            className={`mb-x-scroll -mx-0.5 flex w-[calc(100%+0.25rem)] snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-0.5 pb-1 scroll-smooth transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:mx-0 md:w-full md:grid md:snap-none md:grid-cols-2 md:gap-3 md:overflow-visible md:px-0 md:pb-0 ${transitioning ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0"}`}
          >
            <div
              className={`relative mb-card-enter min-w-full shrink-0 snap-center [scroll-snap-stop:always] rounded-md border transition-all duration-200 ease-out motion-reduce:transition-none md:min-w-0 md:shrink md:snap-none ${mobileBuildView === "a" ? "border-accent/40 md:border-border/70" : "border-border/70"} ${revealModels && revealAction === "A" ? "mb-reveal-highlight-a" : ""} ${revealModels && revealAction === "B" ? "mb-reveal-dim" : ""}`}
            >
              <VoxelViewerCard
                key={matchup ? `${matchup.id}:a` : "arena-build-a"}
                title="Build A"
                subtitle={
                  <ModelReveal
                    revealed={revealModels}
                    provider={matchup?.a.model?.provider}
                    modelName={matchup?.a.model?.displayName}
                  />
                }
                voxelBuild={matchup?.a.build ?? null}
                expectedBlockCount={matchup ? getExpectedBlocksForLane(matchup.a) : undefined}
                meshCacheKey={matchup ? getLaneMeshCacheKey(matchup.a) : null}
                getPremeshedPayloadPromise={
                  matchup
                    ? () => getLanePremeshedPayloadPromise(matchup.id, "a", matchup.a)
                    : undefined
                }
                onPremeshedPayloadConsumed={
                  matchup
                    ? (promise) => consumeLanePremeshedPayload(matchup.id, "a", promise)
                    : undefined
                }
                skipValidation={Boolean(matchup?.a.serverValidated)}
                onBuildReadyChange={(ready) => {
                  const id = matchup?.id;
                  if (!id) return;
                  const current = stateRef.current;
                  if (current.kind !== "ready" || current.matchup.id !== id) return;
                  setViewerReady((prev) => {
                    if (!prev || prev.matchupId !== id) {
                      return { matchupId: id, a: ready, b: false };
                    }
                    if (prev.a === ready) return prev;
                    return { ...prev, a: ready };
                  });
                }}
                onBuildMetrics={(metrics) => {
                  if (!matchup) return;
                  reportBuildRenderMetrics(getLaneHydratedVariant(matchup.a), metrics);
                }}
                isLoading={buildALoading}
                loadingMode={buildALoadingMode}
                loadingMessage={buildALoadingMessage}
                loadingProgress={laneProgressA ?? undefined}
                autoRotate={!isCoarsePointer || mobileBuildView === "a"}
                viewerSize="arena"
                enableBuildExport={Boolean(matchup?.a.build && !laneNeedsFullA)}
                exportLabel={matchup?.a.model?.displayName ?? "build-a"}
                exportPrompt={promptText}
                actions={
                  laneNeedsFullA ? (
                    <button
                      type="button"
                      className="mb-btn mb-btn-ghost h-8 px-3 text-[11px] sm:text-xs"
                      disabled={laneLoadA === "loading-full"}
                      onClick={() => requestFullLaneDetail("a")}
                    >
                      {laneLoadA === "loading-full" ? "Loading..." : "Detail"}
                    </button>
                  ) : null
                }
              />
            </div>
            <div
              className={`relative mb-card-enter mb-card-enter-delay min-w-full shrink-0 snap-center [scroll-snap-stop:always] rounded-md border transition-all duration-200 ease-out motion-reduce:transition-none md:min-w-0 md:shrink md:snap-none ${mobileBuildView === "b" ? "border-accent2/40 md:border-border/70" : "border-border/70"} ${revealModels && revealAction === "B" ? "mb-reveal-highlight-b" : ""} ${revealModels && revealAction === "A" ? "mb-reveal-dim" : ""}`}
            >
              <VoxelViewerCard
                key={matchup ? `${matchup.id}:b` : "arena-build-b"}
                title="Build B"
                subtitle={
                  <ModelReveal
                    revealed={revealModels}
                    provider={matchup?.b.model?.provider}
                    modelName={matchup?.b.model?.displayName}
                  />
                }
                voxelBuild={matchup?.b.build ?? null}
                expectedBlockCount={matchup ? getExpectedBlocksForLane(matchup.b) : undefined}
                meshCacheKey={matchup ? getLaneMeshCacheKey(matchup.b) : null}
                getPremeshedPayloadPromise={
                  matchup
                    ? () => getLanePremeshedPayloadPromise(matchup.id, "b", matchup.b)
                    : undefined
                }
                onPremeshedPayloadConsumed={
                  matchup
                    ? (promise) => consumeLanePremeshedPayload(matchup.id, "b", promise)
                    : undefined
                }
                skipValidation={Boolean(matchup?.b.serverValidated)}
                onBuildReadyChange={(ready) => {
                  const id = matchup?.id;
                  if (!id) return;
                  const current = stateRef.current;
                  if (current.kind !== "ready" || current.matchup.id !== id) return;
                  setViewerReady((prev) => {
                    if (!prev || prev.matchupId !== id) {
                      return { matchupId: id, a: false, b: ready };
                    }
                    if (prev.b === ready) return prev;
                    return { ...prev, b: ready };
                  });
                }}
                onBuildMetrics={(metrics) => {
                  if (!matchup) return;
                  reportBuildRenderMetrics(getLaneHydratedVariant(matchup.b), metrics);
                }}
                isLoading={buildBLoading}
                loadingMode={buildBLoadingMode}
                loadingMessage={buildBLoadingMessage}
                loadingProgress={laneProgressB ?? undefined}
                autoRotate={!isCoarsePointer || mobileBuildView === "b"}
                viewerSize="arena"
                enableBuildExport={Boolean(matchup?.b.build && !laneNeedsFullB)}
                exportLabel={matchup?.b.model?.displayName ?? "build-b"}
                exportPrompt={promptText}
                actions={
                  laneNeedsFullB ? (
                    <button
                      type="button"
                      className="mb-btn mb-btn-ghost h-8 px-3 text-[11px] sm:text-xs"
                      disabled={laneLoadB === "loading-full"}
                      onClick={() => requestFullLaneDetail("b")}
                    >
                      {laneLoadB === "loading-full" ? "Loading..." : "Detail"}
                    </button>
                  ) : null
                }
              />
            </div>
          </div>

          {/* segmented build switcher – mobile only */}
          <div className="md:hidden">
            <div className="flex rounded-md border border-border/70">
              <button
                type="button"
                aria-pressed={mobileBuildView === "a"}
                aria-current={mobileBuildView === "a" ? "true" : undefined}
                aria-label="Show Build A"
                className={`flex h-10 flex-1 items-center justify-center rounded-[10px] text-center font-mono text-[11px] font-semibold uppercase tracking-[0.13em] transition-colors ${
                  mobileBuildView === "a"
                    ? "bg-card/80 text-fg ring-1 ring-border/65 shadow-[inset_0_1px_0_hsl(var(--fg)_/_0.08)]"
                    : "text-muted/60 hover:bg-bg/45 hover:text-fg"
                }`}
                disabled={buildSwitchDisabled}
                onClick={() => scrollToMobileBuild("a")}
              >
                <span>Build A</span>
              </button>
              <button
                type="button"
                aria-pressed={mobileBuildView === "b"}
                aria-current={mobileBuildView === "b" ? "true" : undefined}
                aria-label="Show Build B"
                className={`flex h-10 flex-1 items-center justify-center rounded-[10px] text-center font-mono text-[11px] font-semibold uppercase tracking-[0.13em] transition-colors ${
                  mobileBuildView === "b"
                    ? "bg-card/80 text-fg ring-1 ring-border/65 shadow-[inset_0_1px_0_hsl(var(--fg)_/_0.08)]"
                    : "text-muted/60 hover:bg-bg/45 hover:text-fg"
                }`}
                disabled={buildSwitchDisabled}
                onClick={() => scrollToMobileBuild("b")}
              >
                <span>Build B</span>
              </button>
            </div>
          </div>

	          {buildLoadError ? (
	            <div className="flex items-center justify-between gap-3 border-t border-border/70 px-1 py-2 text-sm text-muted">
	              <span>{buildLoadError}</span>
	              <div className="flex shrink-0 items-center gap-2">
	                <button
	                  type="button"
	                  className="mb-btn mb-btn-ghost h-8 px-3 text-[11px] sm:text-xs"
	                  onClick={() => {
	                    if (laneErrorA) retryLaneBuild("a");
	                    if (laneErrorB) retryLaneBuild("b");
	                  }}
	                >
	                  Retry
	                </button>
	                <button
	                  type="button"
	                  className="mb-btn mb-btn-ghost h-8 px-3 text-[11px] sm:text-xs"
	                  onClick={() => {
	                    void handleSkip();
	                  }}
	                >
	                  Skip
	                </button>
	              </div>
	            </div>
	          ) : null}

	          {/* action bar (vote buttons ↔ reveal status) */}
          {/* Both states share one grid cell, so the bar is exactly as tall as
             the vote controls need and the crossfade shifts nothing. */}
          <div className="grid">
            <div
              className={`[grid-area:1/1] transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${revealMeta.visible ? "pointer-events-none opacity-0 translate-y-1" : "opacity-100 translate-y-0"}`}
            >
              <VoteBar
                disabled={state.kind !== "ready" || submitting || transitioning}
                disableVotes={state.kind !== "ready" || matchupBuildLoading}
                onVote={handleVote}
                onSkip={handleSkip}
                confirming={voteConfirming}
              />
            </div>

            <div
              aria-hidden={!revealMeta.visible}
              className={`[grid-area:1/1] transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${revealMeta.visible ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 -translate-y-1"}`}
            >
              <div className="flex h-full flex-col justify-center gap-3 border-t border-border/70 px-1 py-2 sm:py-3">
                <div key={matchup?.id} className="grid grid-cols-2 gap-2 sm:gap-3">
                  <RevealLane
                    side="A"
                    model={matchup?.a.model}
                    chosen={revealAction === "A"}
                    faded={revealAction === "B"}
                  />
                  <RevealLane
                    side="B"
                    model={matchup?.b.model}
                    chosen={revealAction === "B"}
                    faded={revealAction === "A"}
                    delayed
                  />
                </div>

                <div className="flex items-center gap-3">
                  <div className="relative h-px min-w-0 flex-1 bg-border/50">
                    <div
                      className="absolute inset-y-0 left-0 bg-accent/70 transition-[width] duration-100 ease-linear motion-reduce:transition-none"
                      style={{ width: `${(revealMeta.progress * 100).toFixed(1)}%` }}
                    />
                    {revealMeta.waitingForNext ? (
                      <div className="mb-progress-wait absolute inset-0" />
                    ) : null}
                  </div>

                  {revealVerdict ? (
                    <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] text-muted2">
                      {revealVerdict}
                    </span>
                  ) : null}

                  <button
                    type="button"
                    className="mb-btn mb-btn-ghost h-8 shrink-0 px-3 text-xs"
                    disabled={transitioning}
                    onClick={() => {
                      if (reveal.kind !== "reveal" || reveal.matchupId !== matchup?.id) return;
                      if (!reveal.next) {
                        requestAdvanceNow(reveal.matchupId);
                        return;
                      }
                      void advanceToNext(reveal.matchupId, reveal.next);
                    }}
                  >
                    Next
                    <span className="hidden md:inline"><span className="mb-kbd">Space</span></span>
                  </button>
                </div>
              </div>
            </div>
          </div>
      </div>

      {/* how it works — pipeline diagram */}
      <section className="border-t border-border/70 pt-8 sm:pt-10">
        <div className="flex w-full flex-col">
          <h2 className="font-display text-[clamp(1.6rem,3.4vw,2.4rem)] font-semibold leading-tight tracking-tight text-fg">
            How it works
          </h2>
          <p className="mb-8 mt-3 max-w-[62ch] text-[15px] leading-relaxed text-muted sm:mb-10 sm:text-base">
            Models read a text prompt and output raw block coordinates — no images, no 3D tools.
            Humans vote pair-wise, and the rankings follow.
          </p>

          <div className="grid w-full grid-cols-1 items-stretch gap-5 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:gap-6">
            {/* 01 — Prompt */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="mb-step-num">01</span>
                <span className="mb-eyebrow">Prompt</span>
              </div>
              <figure className="border-t border-border/70 pt-4 font-mono text-[12px] italic leading-relaxed text-fg/85">
                &ldquo;A warm wooden cabin beside a pond, with a stone chimney, a small dock, and a few trees.&rdquo;
              </figure>
              <p className="text-sm leading-relaxed text-fg/70">
                Curated, natural-language prompts probe spatial reasoning.
              </p>
            </div>

            <PipelineArrow />

            {/* 02 — Generate */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="mb-step-num">02</span>
                <span className="mb-eyebrow">Generate</span>
              </div>
              <figure className="relative border-t border-accent/40 pt-4 font-mono text-[11px] leading-relaxed text-fg/85">
                <pre className="overflow-x-auto whitespace-pre">
{`{
  "version": "1.0",
  "blocks": [
    {"x":0,"y":0,"z":0,"type":`}<span className="text-accent">&quot;oak_log&quot;</span>{`},
    {"x":1,"y":0,"z":0,"type":`}<span className="text-accent">&quot;stone&quot;</span>{`},
    …
  ]
}`}
                </pre>
                <span className="absolute bottom-0 right-0 font-mono text-[10px] text-muted/70">
                  1,247 blocks
                </span>
              </figure>
              <p className="text-sm leading-relaxed text-fg/70">
                Models output raw block coordinates. We render them directly — no post-processing.
              </p>
            </div>

            <PipelineArrow />

            {/* 03 — Vote & rank */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="mb-step-num">03</span>
                <span className="mb-eyebrow">Vote &amp; rank</span>
              </div>
              <figure className="flex flex-col gap-3 border-t border-border/70 pt-4">
                <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
                  <span className="inline-flex h-7 items-center rounded-md border border-accent/40 px-2.5 font-medium text-accent">
                    A wins
                  </span>
                  <span className="hidden text-muted/60 sm:inline">·</span>
                  <span className="inline-flex h-7 items-center rounded-md border border-border/70 px-2.5 font-medium text-muted">
                    Tie
                  </span>
                  <span className="hidden text-muted/60 sm:inline">·</span>
                  <span className="inline-flex h-7 items-center rounded-md border border-accent2/40 px-2.5 font-medium text-accent2">
                    B wins
                  </span>
                </div>
                <div className="flex flex-col gap-1 font-mono text-[11px]">
                  <div className="flex items-center justify-between text-fg/90">
                    <span>GPT-5.4</span>
                    <span className="text-accent">2150</span>
                  </div>
                  <div className="flex items-center justify-between text-fg/75">
                    <span>Claude 4.5</span>
                    <span>2108</span>
                  </div>
                  <div className="flex items-center justify-between text-fg/60">
                    <span>Gemini 3 Pro</span>
                    <span>2091</span>
                  </div>
                </div>
              </figure>
              <p className="text-sm leading-relaxed text-fg/70">
                Every vote feeds a live Elo leaderboard.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* sandbox cta - moved to bottom & polished */}
      <section className="flex flex-col gap-4 border-t border-border/70 pt-8 sm:flex-row sm:items-end sm:justify-between sm:gap-10 sm:pt-10">
        <div className="flex flex-col gap-2">
          <h2 className="font-display text-[clamp(1.6rem,3.4vw,2.4rem)] font-semibold leading-tight tracking-tight text-fg">
            Build your own
          </h2>
          <p className="max-w-[48ch] text-[15px] leading-relaxed text-muted">
            Any prompt, any model, rendered live.
          </p>
        </div>
        <form
          className="relative flex w-full items-center sm:max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            const q = customPrompt.trim();
            window.location.href = `/sandbox${q ? `?prompt=${encodeURIComponent(q)}` : ""}`;
          }}
        >
          <input
            aria-label="Prompt for the sandbox"
            className="mb-field h-12 w-full pr-[7.5rem] text-base"
            placeholder="e.g. A giant rubber duck…"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
          />
          <a
            className="mb-btn mb-btn-primary absolute right-1.5 top-1.5 bottom-1.5 flex items-center px-4 text-sm"
            href={`/sandbox${customPrompt.trim() ? `?prompt=${encodeURIComponent(customPrompt.trim())}` : ""}`}
          >
            Generate
          </a>
        </form>
      </section>
    </div>
  );
}
