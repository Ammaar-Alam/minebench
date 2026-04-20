"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  ModelDetailStats,
  ModelOpponentBreakdown,
  ModelPromptBreakdown,
} from "@/lib/arena/stats";
import type {
  ArenaBuildLoadHints,
  ArenaBuildRef,
  ArenaBuildStreamEvent,
  ArenaBuildVariant,
} from "@/lib/arena/types";
import {
  VoxelLoadingHud,
  formatVoxelLoadingMessage,
  type VoxelLoadingProgress,
} from "@/components/voxel/VoxelLoadingHud";
import type {
  VoxelViewerBuildProgress,
  VoxelViewerHandle,
} from "@/components/voxel/VoxelViewer";
import { summarizeArenaVotes } from "@/lib/arena/voteMath";
import type { VoxelBuild } from "@/lib/voxel/types";
import { ModelLateralNav, PromptLateralNav } from "@/components/leaderboard/LateralNav";
import {
  SandboxGifExportButton,
  type SandboxGifExportTarget,
} from "@/components/sandbox/SandboxGifExportButton";

const CHART_WIDTH = 900;
const CHART_HEIGHT = 304;
const CHART_PAD_LEFT = 28;
const CHART_PAD_RIGHT = 24;
const CHART_PAD_TOP = 16;
const CHART_PAD_BOTTOM = 34;
const INITIAL_VISIBLE_OPPONENTS = 8;
const INITIAL_VISIBLE_PROMPTS = 8;
const SNAPSHOT_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_SNAPSHOT_TIMEOUT_MS ?? "12000",
  10,
);
const STREAM_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_REQUEST_TIMEOUT_MS ?? "12000",
  10,
);
const STREAM_FIRST_EVENT_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_FIRST_EVENT_TIMEOUT_MS ?? "6000",
  10,
);
const STREAM_STALL_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_STALL_TIMEOUT_MS ?? "10000",
  10,
);
const STREAM_HARD_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_STREAM_HARD_TIMEOUT_MS ?? "35000",
  10,
);

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

async function readWithTimeout<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? window.setTimeout(() => {
            cleanup();
            reject(new Error("Build stream stalled"));
          }, timeoutMs)
        : null;
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      if (timer != null) window.clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    read().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

type CurvePoint = { x: number; y: number; value: number };
type LoadedPromptBuild = {
  buildId: string;
  voxelBuild: VoxelBuild;
  gridSize: number;
  palette: "simple" | "advanced";
  mode: string;
  blockCount: number;
};

type BuildVariantResponse = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
  serverValidated: boolean;
  buildLoadHints?: ArenaBuildLoadHints;
  voxelBuild: VoxelBuild;
};

type BuildStreamProgress = {
  receivedBlocks: number;
  totalBlocks: number | null;
  chunkIndex: number | null;
  chunkCount: number | null;
};

type FetchBuildVariantStreamOptions = {
  signal?: AbortSignal;
  onProgress?: (
    build: VoxelBuild,
    progress: BuildStreamProgress,
    meta: { serverValidated: boolean },
  ) => void;
};

const LazyVoxelViewer = dynamic(
  () => import("@/components/voxel/VoxelViewer").then((mod) => mod.VoxelViewer),
  { ssr: false },
);

function parseArenaBuildStreamLine(line: string): ArenaBuildStreamEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as ArenaBuildStreamEvent;
  } catch {
    return null;
  }
}

async function fetchBuildVariantSnapshot(
  ref: ArenaBuildRef,
  signal?: AbortSignal,
  timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS,
): Promise<BuildVariantResponse> {
  const url = new URL(`/api/arena/builds/${encodeURIComponent(ref.buildId)}`, window.location.origin);
  url.searchParams.set("variant", ref.variant);
  if (ref.checksum) url.searchParams.set("checksum", ref.checksum);
  const timed = makeTimeoutSignal(signal, timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: timed.signal });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as BuildVariantResponse;
  } finally {
    timed.cleanup();
  }
}

async function fetchBuildVariantStreamOnce(
  ref: ArenaBuildRef,
  useArtifact: boolean,
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
      signal: requestTimed.signal,
    });
  } finally {
    requestTimed.cleanup();
  }
  if (!res.ok) throw new Error(await res.text());

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.body || !contentType.includes("application/x-ndjson")) {
    return (await res.json()) as BuildVariantResponse;
  }

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const startedAt = performance.now();

    let resolvedVariant: ArenaBuildVariant = ref.variant;
    let checksum: string | null = ref.checksum ?? null;
    let serverValidated = false;
    let buildLoadHints: ArenaBuildLoadHints | undefined;
    let totalBlocks: number | null = null;
    let hasComplete = false;
    let sawFirstEvent = false;

    const streamedBlocks: VoxelBuild["blocks"] = [];

    const emitProgress = (progress: BuildStreamProgress) => {
      if (!opts?.onProgress) return;
      opts.onProgress(
        {
          version: "1.0",
          blocks: streamedBlocks,
        },
        progress,
        { serverValidated },
      );
    };

    const processLine = (line: string) => {
      const event = parseArenaBuildStreamLine(line);
      if (!event) return;

      if (event.type === "ping") {
        sawFirstEvent = true;
        return;
      }
      if (event.type === "error") {
        throw new Error(event.message || "Build stream failed");
      }
      if (event.type === "hello") {
        sawFirstEvent = true;
        resolvedVariant = event.variant;
        checksum = event.checksum ?? checksum;
        serverValidated = serverValidated || event.serverValidated;
        totalBlocks = event.totalBlocks || totalBlocks;
        buildLoadHints = event.buildLoadHints ?? buildLoadHints;
        if (streamedBlocks.length === 0) {
          emitProgress({
            receivedBlocks: 0,
            totalBlocks,
            chunkIndex: null,
            chunkCount: event.chunkCount ?? null,
          });
        }
        return;
      }
      if (event.type === "chunk") {
        sawFirstEvent = true;
        if (Array.isArray(event.blocks) && event.blocks.length > 0) {
          streamedBlocks.push(...event.blocks);
        }
        totalBlocks = event.totalBlocks || totalBlocks;
        emitProgress({
          receivedBlocks: event.receivedBlocks,
          totalBlocks,
          chunkIndex: event.index,
          chunkCount: event.chunkCount,
        });
        return;
      }
      if (event.type === "complete") {
        hasComplete = true;
        totalBlocks = event.totalBlocks || totalBlocks;
      }
    };

    while (true) {
      if (performance.now() - startedAt > STREAM_HARD_TIMEOUT_MS) {
        throw new Error("Build stream hard timeout");
      }

      const { done, value } = await readWithTimeout(
        () => reader.read(),
        sawFirstEvent ? STREAM_STALL_TIMEOUT_MS : STREAM_FIRST_EVENT_TIMEOUT_MS,
        opts?.signal,
      );
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        processLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);

    const announcedTotal =
      typeof totalBlocks === "number" && Number.isFinite(totalBlocks) && totalBlocks >= 0
        ? totalBlocks
        : null;
    const streamLooksComplete =
      hasComplete && (announcedTotal == null || streamedBlocks.length >= announcedTotal);

    if (!streamLooksComplete) {
      return fetchBuildVariantSnapshot(ref, opts?.signal);
    }

    return {
      buildId: ref.buildId,
      variant: resolvedVariant,
      checksum,
      serverValidated,
      buildLoadHints,
      voxelBuild: {
        version: "1.0",
        blocks: streamedBlocks,
      },
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw err;
  }
}

async function fetchBuildVariantStream(
  ref: ArenaBuildRef,
  opts?: FetchBuildVariantStreamOptions,
): Promise<BuildVariantResponse> {
  let lastError: unknown = null;
  const attempts: Array<() => Promise<BuildVariantResponse>> = [
    () => fetchBuildVariantStreamOnce(ref, true, opts),
    () => fetchBuildVariantSnapshot(ref, opts?.signal),
    () => fetchBuildVariantStreamOnce(ref, false, opts),
    () => fetchBuildVariantSnapshot(ref, opts?.signal, SNAPSHOT_FETCH_TIMEOUT_MS * 2),
  ];

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError" && opts?.signal?.aborted) {
        throw err;
      }
      lastError = err;
    }
  }

  throw (lastError instanceof Error ? lastError : new Error("Failed to retrieve build"));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function formatPercent(value: number | null, digits = 0): string {
  if (value == null) return "-";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatSignedPercent(value: number | null, digits = 1): string {
  if (value == null) return "-";
  const pct = (value * 100).toFixed(digits);
  return `${value > 0 ? "+" : ""}${pct}%`;
}

function consistencyLabel(consistency: number | null): string {
  if (consistency == null) return "Insufficient data";
  if (consistency >= 78) return "Very steady";
  if (consistency >= 58) return "Balanced";
  return "High swing";
}

function consistencyTone(consistency: number | null): string {
  if (consistency == null) return "text-muted";
  if (consistency >= 78) return "text-success";
  if (consistency >= 58) return "text-accent";
  return "text-warn";
}

function scoreBarClass(score: number): string {
  if (score >= 0.66) return "bg-success/75";
  if (score >= 0.5) return "bg-accent/75";
  if (score >= 0.35) return "bg-warn/75";
  return "bg-danger/75";
}

function winRateTone(value: number | null): string {
  if (value == null) return "text-muted";
  if (value >= 0.58) return "text-success";
  if (value >= 0.45) return "text-accent";
  return "text-warn";
}

function momentumTone(delta: number | null): string {
  if (delta == null) return "text-muted";
  if (delta > 0.005) return "text-success";
  if (delta < -0.005) return "text-danger";
  return "text-muted";
}

function stabilityTextClass(stability: string): string {
  if (stability === "Stable") return "text-success";
  if (stability === "Established") return "text-accent";
  return "text-warn";
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const listener = () => setReduced(mq.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);
  return reduced;
}

// Counts from 0 → target on mount with ease-out-quart. null targets snap to
// 0 so format helpers can still render "-" when they see null.
function useCountUp(target: number | null, duration = 900): number {
  const [current, setCurrent] = useState<number>(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (target == null) {
      setCurrent(0);
      return;
    }
    if (reduced) {
      setCurrent(target);
      return;
    }

    const start = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      setCurrent(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced]);

  return current;
}

function MomentumArrow({ delta }: { delta: number | null }) {
  if (delta == null || Math.abs(delta) < 0.005) {
    return (
      <svg
        className="h-3 w-3 shrink-0"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 6H10" />
      </svg>
    );
  }
  const up = delta > 0;
  return (
    <svg
      className="h-3 w-3 shrink-0"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {up ? (
        <>
          <path d="M3 8L8.5 3" />
          <path d="M4.5 3H8.5V7" />
        </>
      ) : (
        <>
          <path d="M3 3L8.5 8" />
          <path d="M8.5 4V8H4.5" />
        </>
      )}
    </svg>
  );
}

function topStrongest(prompts: ModelPromptBreakdown[]) {
  return [...prompts]
    .filter((p) => p.votes >= 2)
    .sort((a, b) => b.averageScore - a.averageScore || b.votes - a.votes)
    .slice(0, 6);
}

function topWeakest(prompts: ModelPromptBreakdown[]) {
  return [...prompts]
    .filter((p) => p.votes >= 2)
    .sort((a, b) => a.averageScore - b.averageScore || b.votes - a.votes)
    .slice(0, 6);
}

function topOpponents(opponents: ModelOpponentBreakdown[]) {
  return [...opponents].sort((a, b) => b.votes - a.votes || b.averageScore - a.averageScore);
}

function buildCurve(values: number[]): {
  linePath: string;
  areaPath: string;
  points: CurvePoint[];
} {
  if (values.length === 0) {
    return { linePath: "", areaPath: "", points: [] };
  }

  const innerWidth = CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT;
  const innerHeight = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
  const denom = Math.max(1, values.length - 1);

  const points = values.map((value, index) => ({
    value,
    x: CHART_PAD_LEFT + (index / denom) * innerWidth,
    y: CHART_PAD_TOP + (1 - clamp01(value)) * innerHeight,
  }));

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");

  const baselineY = CHART_HEIGHT - CHART_PAD_BOTTOM;
  const first = points[0];
  const last = points[points.length - 1];

  const areaPath = [
    `M ${first.x.toFixed(2)} ${baselineY.toFixed(2)}`,
    ...points.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
    `L ${last.x.toFixed(2)} ${baselineY.toFixed(2)}`,
    "Z",
  ].join(" ");

  return { linePath, areaPath, points };
}

function MetricTile({
  label,
  value,
  sub,
  tone = "text-fg",
  valueClassName = "text-[1.72rem] font-semibold leading-tight tracking-tight",
  leading,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  valueClassName?: string;
  leading?: ReactNode;
}) {
  return (
    <div className="mb-metric-tile">
      <div className="text-[10px] uppercase tracking-[0.11em] text-muted">{label}</div>
      <div className={`mt-0.5 flex items-center gap-1.5 ${valueClassName} ${tone}`}>
        {leading}
        <span className="tabular-nums">{value}</span>
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

// Renders a number that counts up from 0 on mount. Pass a pre-formatted string
// via `format` — handles trailing units ("%", "k") and sign prefixes cleanly.
function AnimatedNumber({
  value,
  format,
  duration = 900,
}: {
  value: number | null;
  format: (current: number) => string;
  duration?: number;
}) {
  const current = useCountUp(value, duration);
  if (value == null) return <>-</>;
  return <>{format(current)}</>;
}

function ConsistencyGauge({
  value,
  size = 148,
}: {
  value: number | null;
  size?: number;
}) {
  // Single count-up source drives both the ring offset and the center number
  // so they tick in lockstep. Ring keeps its own 700ms CSS transition for
  // subsequent value changes — the mount animation uses the count-up value.
  const animated = useCountUp(value, 1100);
  const safe = Math.max(0, Math.min(100, animated));

  // keep ring proportions constant across sizes — base design is 148px/r=62/stroke=9
  const radius = (62 / 148) * size;
  const strokeWidth = Math.max(4, (9 / 148) * size);
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - safe / 100);
  const center = size / 2;
  const numberSize = size >= 120 ? "text-[1.65rem]" : size >= 88 ? "text-[1.15rem]" : "text-[0.95rem]";

  return (
    <div
      className="relative shrink-0"
      style={{ height: `${size}px`, width: `${size}px` }}
    >
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="hsl(var(--border) / 0.45)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="hsl(var(--accent) / 0.9)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${circumference.toFixed(2)} ${circumference.toFixed(2)}`}
          strokeDashoffset={offset.toFixed(2)}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: "stroke-dashoffset 240ms cubic-bezier(0.22, 1, 0.36, 1)" }}
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className={`${numberSize} font-semibold leading-none tabular-nums ${consistencyTone(value)}`}
        >
          {value != null ? Math.round(animated) : "-"}
        </div>
      </div>
    </div>
  );
}

function HeadToHeadCard({ opponent }: { opponent: ModelOpponentBreakdown }) {
  const total = Math.max(1, opponent.wins + opponent.losses + opponent.draws);
  const winPct = (opponent.wins / total) * 100;
  const lossPct = (opponent.losses / total) * 100;
  const drawPct = Math.max(0, 100 - winPct - lossPct);

  return (
    <Link
      href={`/leaderboard/${opponent.key}`}
      className="mb-head-to-head-card mb-card-enter group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      aria-label={`Open ${opponent.displayName} profile`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-fg transition group-hover:text-accent">
            {opponent.displayName}
          </div>
          <div className="text-xs text-muted">{opponent.votes} votes</div>
        </div>
        <div className="font-mono text-sm text-fg">{formatPercent(opponent.averageScore)}</div>
      </div>
      <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-border/35">
        <span style={{ width: `${winPct.toFixed(2)}%` }} className="bg-success/85" />
        <span style={{ width: `${lossPct.toFixed(2)}%` }} className="bg-danger/80" />
        <span style={{ width: `${drawPct.toFixed(2)}%` }} className="bg-muted/65" />
      </div>
      <div className="mt-2 inline-flex items-center gap-1 font-mono text-[11px]">
        <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-success">
          W {opponent.wins}
        </span>
        <span className="rounded-full bg-danger/12 px-1.5 py-0.5 text-danger">
          L {opponent.losses}
        </span>
        <span className="rounded-full bg-bg/55 px-1.5 py-0.5 text-muted">D {opponent.draws}</span>
      </div>
    </Link>
  );
}

const PromptBuildPreview = memo(function PromptBuildPreview({
  build,
  loading = false,
  loadingLabel,
  loadingProgress,
  error = null,
  heightClass = "h-44",
  overlay,
  viewerRef,
  actions,
}: {
  build: LoadedPromptBuild | null;
  loading?: boolean;
  loadingLabel?: string;
  loadingProgress?: VoxelLoadingProgress | null;
  error?: string | null;
  heightClass?: string;
  /** when provided, replaces the default blocks pill with caller-supplied
      overlay content (typically the combined votes · score · blocks chip
      used in the prompt modal). rendered absolute-positioned inside the
      preview container, so callers should include their own positioning. */
  overlay?: ReactNode;
  /** ref forwarded to the underlying VoxelViewer — needed by callers that
      want to invoke handle methods like captureFrame (e.g. the gif exporter). */
  viewerRef?: React.RefObject<VoxelViewerHandle | null>;
  /** action slot pinned to the preview's top-right corner. typically a single
      icon button (gif export); multiple buttons stack horizontally. */
  actions?: ReactNode;
}) {
  type PlacementProgressState = VoxelLoadingProgress & { stageLabel?: string | null };

  const [viewerReady, setViewerReady] = useState(false);
  const [placementProgress, setPlacementProgress] = useState<PlacementProgressState | null>(null);
  useEffect(() => {
    setViewerReady(false);
    setPlacementProgress(null);
  }, [build?.buildId]);
  const handleBuildReadyChange = useCallback((ready: boolean) => {
    setViewerReady(ready);
    if (ready) setPlacementProgress(null);
  }, []);
  const handleBuildProgressChange = useCallback(
    (progress: VoxelViewerBuildProgress | null) => {
      if (!progress) {
        setPlacementProgress(null);
        return;
      }
      setPlacementProgress({
        receivedBlocks: Math.max(0, Math.floor(progress.processedBlocks)),
        totalBlocks: Math.max(1, Math.floor(progress.totalBlocks)),
        stageLabel: progress.stageLabel ?? null,
      });
    },
    [],
  );
  const placementLoading = Boolean(build && !loading && !viewerReady);
  const overlayProgress = loading
    ? loadingProgress ?? null
    : placementProgress ??
      (placementLoading
        ? {
            receivedBlocks: 0,
            totalBlocks: build?.blockCount ?? null,
          }
        : null);
  const overlayLabel = loading
    ? loadingLabel ?? "Retrieving build..."
    : formatVoxelLoadingMessage(placementProgress?.stageLabel ?? "Placing blocks", placementProgress);

  if (loading && !build) {
    return (
      <div className={`relative flex w-full items-center justify-center overflow-hidden rounded-xl bg-bg/42 ring-1 ring-border/65 ${heightClass}`}>
        <VoxelLoadingHud
          label={overlayLabel}
          progress={overlayProgress}
          className="pointer-events-none absolute left-2.5 top-2.5 z-20"
        />
      </div>
    );
  }

  if (!build) {
    return (
      <div className={`relative flex w-full items-center justify-center overflow-hidden rounded-xl bg-bg/42 ring-1 ring-border/65 ${heightClass}`}>
        <div className="text-xs text-muted">{error ? "Build unavailable" : "No build yet"}</div>
      </div>
    );
  }

  return (
    <div className={`relative w-full overflow-hidden rounded-xl bg-bg/32 ring-1 ring-border/65 ${heightClass}`}>
      <LazyVoxelViewer
        ref={viewerRef}
        voxelBuild={build.voxelBuild}
        palette={build.palette}
        autoRotate
        showControls={false}
        onBuildReadyChange={handleBuildReadyChange}
        onBuildProgressChange={handleBuildProgressChange}
      />
      {loading || placementLoading ? (
        <VoxelLoadingHud
          label={overlayLabel}
          progress={overlayProgress}
          className="pointer-events-none absolute left-2.5 top-2.5 z-20"
        />
      ) : null}
      {actions ? (
        <div className="absolute right-2.5 top-2.5 z-20 flex items-center gap-1.5">
          {actions}
        </div>
      ) : null}
      {overlay !== undefined ? (
        overlay
      ) : (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg/88 via-bg/56 to-transparent p-2.5">
          <span className="inline-flex items-center rounded-full bg-bg/76 px-2 py-0.5 font-mono text-[10px] text-muted ring-1 ring-border/75">
            {build.blockCount.toLocaleString()} blocks
          </span>
        </div>
      )}
    </div>
  );
});

function PromptEdgeRow({
  prompt,
  rank,
  tone,
  delayMs,
}: {
  prompt: ModelPromptBreakdown;
  rank: number;
  tone: "strong" | "weak";
  delayMs?: number;
}) {
  const scorePct = Math.max(0, Math.min(100, prompt.averageScore * 100));
  const toneTextClass = tone === "strong" ? "text-success" : "text-danger";
  const toneBarClass =
    tone === "strong" ? "from-success/85 via-accent/72 to-accent2/55" : "from-danger/88 via-warn/72 to-accent2/55";

  return (
    <article
      className="mb-card-enter py-3 first:pt-1.5 last:pb-1.5"
      style={delayMs != null ? { animationDelay: `${delayMs}ms` } : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center rounded-full bg-bg/58 px-2 py-0.5 font-mono text-[10px] text-muted ring-1 ring-border/65">
            #{rank}
          </div>
          <div className="mt-2 mb-clamp-prompt-tight text-sm text-fg/92">{prompt.promptText}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`font-mono text-base ${toneTextClass}`}>{formatPercent(prompt.averageScore)}</div>
          <div className="mt-0.5 text-xs text-muted">{prompt.votes} votes</div>
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/35">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${toneBarClass}`}
          style={{ width: `${scorePct.toFixed(1)}%` }}
        />
      </div>
    </article>
  );
}

function SectionHeader({
  eyebrow,
  title,
  meta,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-muted">{eyebrow}</div>
        <div className="text-[1.12rem] font-semibold leading-tight text-fg">{title}</div>
      </div>
      {meta ? <div className="text-xs text-muted">{meta}</div> : null}
    </div>
  );
}

export function ModelDetail({ data }: { data: ModelDetailStats }) {
  const [hoveredCurveIndex, setHoveredCurveIndex] = useState<number | null>(null);
  const [showAllOpponents, setShowAllOpponents] = useState(false);
  const [showAllPrompts, setShowAllPrompts] = useState(false);
  const [activePrompt, setActivePrompt] = useState<ModelPromptBreakdown | null>(null);
  const [buildCache, setBuildCache] = useState<Record<string, LoadedPromptBuild>>({});
  const buildCacheRef = useRef<Record<string, LoadedPromptBuild>>({});
  const activeRequestRef = useRef(0);
  const [activeStreamingBuild, setActiveStreamingBuild] = useState<LoadedPromptBuild | null>(null);
  const [activeBuildProgress, setActiveBuildProgress] = useState<{
    receivedBlocks: number;
    totalBlocks: number | null;
  } | null>(null);
  const [activeBuildError, setActiveBuildError] = useState<string | null>(null);
  const lastPromptTriggerRef = useRef<HTMLElement | null>(null);
  const modalCloseRef = useRef<HTMLButtonElement | null>(null);
  const modalSurfaceRef = useRef<HTMLDivElement | null>(null);
  const modalWasOpenRef = useRef(false);
  const modalViewerRef = useRef<VoxelViewerHandle | null>(null);

  const strongest = topStrongest(data.prompts);
  const weakest = topWeakest(data.prompts);
  const opponents = topOpponents(data.opponents);

  const promptCurveSource = useMemo(
    () =>
      data.prompts
        .filter((prompt) => prompt.votes >= 2)
        .sort((a, b) => b.averageScore - a.averageScore)
        .slice(0, 36),
    [data.prompts],
  );

  const promptCurveValues = promptCurveSource.map((prompt) => prompt.averageScore);
  const curve = useMemo(() => buildCurve(promptCurveValues), [promptCurveValues]);
  const strongestCurveScore = promptCurveValues[0] ?? null;
  const weakestCurveScore = promptCurveValues[promptCurveValues.length - 1] ?? null;

  const bestPromptScore = strongest[0]?.averageScore ?? null;
  const weakPromptScore = weakest[0]?.averageScore ?? null;
  const voteSummary = summarizeArenaVotes(data.model);
  const decisiveVotes = voteSummary.decisiveVotes;
  const coveragePercent = Math.round((data.summary.promptCoverage ?? 0) * 100);
  const coverageLabel =
    data.summary.activePrompts > 0
      ? `${data.summary.coveredPrompts}/${data.summary.activePrompts}`
      : "0/0";

  const promptBreakdown = useMemo(
    () =>
      [...data.prompts].sort(
        (a, b) =>
          b.averageScore - a.averageScore ||
          b.votes - a.votes ||
          a.promptText.localeCompare(b.promptText),
      ),
    [data.prompts],
  );
  const maxPromptVotes = Math.max(1, ...promptBreakdown.map((prompt) => prompt.votes));
  const visibleOpponents = showAllOpponents
    ? opponents
    : opponents.slice(0, INITIAL_VISIBLE_OPPONENTS);
  const visiblePromptBreakdown = showAllPrompts
    ? promptBreakdown
    : promptBreakdown.slice(0, INITIAL_VISIBLE_PROMPTS);
  const hasHiddenOpponents = opponents.length > INITIAL_VISIBLE_OPPONENTS;
  const hasHiddenPrompts = promptBreakdown.length > INITIAL_VISIBLE_PROMPTS;
  const hoveredPoint = hoveredCurveIndex != null ? curve.points[hoveredCurveIndex] : null;
  const hoveredPrompt = hoveredCurveIndex != null ? promptCurveSource[hoveredCurveIndex] : null;
  const activeBuildId = activePrompt?.build?.buildId ?? null;
  const activeBuildMeta = activePrompt?.build ?? null;
  const activeCachedBuild = activeBuildId ? buildCache[activeBuildId] ?? null : null;
  const activeLoadedBuild =
    activeStreamingBuild && activeStreamingBuild.buildId === activeBuildId
      ? activeStreamingBuild
      : activeCachedBuild;
  const isActiveBuildLoading = Boolean(
    activePrompt?.build &&
      activeBuildId &&
      !activeCachedBuild &&
      activeBuildError == null,
  );
  const activeBuildLoadingLabel = useMemo(
    () => formatVoxelLoadingMessage("Retrieving build", activeBuildProgress),
    [activeBuildProgress],
  );
  const tooltipAlignClass =
    hoveredCurveIndex == null
      ? "mb-curve-tooltip-center"
      : hoveredCurveIndex <= 1
        ? "mb-curve-tooltip-left"
        : hoveredCurveIndex >= curve.points.length - 2
          ? "mb-curve-tooltip-right"
          : "mb-curve-tooltip-center";

  useEffect(() => {
    if (!activePrompt) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setActivePrompt(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePrompt]);

  const activePromptIndex = useMemo(() => {
    if (!activePrompt) return -1;
    return promptBreakdown.findIndex((p) => p.promptId === activePrompt.promptId);
  }, [activePrompt, promptBreakdown]);

  const modalExportTargets: SandboxGifExportTarget[] = useMemo(() => {
    if (!activePrompt?.build) return [];
    return [
      {
        viewerRef: modalViewerRef,
        modelName: data.model.displayName,
        company: data.model.provider,
        blockCount: activePrompt.build.blockCount,
      },
    ];
  }, [activePrompt, data.model.displayName, data.model.provider]);

  const handlePromptPrev = useCallback(() => {
    if (activePromptIndex <= 0) return;
    setActivePrompt(promptBreakdown[activePromptIndex - 1]);
  }, [activePromptIndex, promptBreakdown]);

  const handlePromptNext = useCallback(() => {
    if (activePromptIndex < 0 || activePromptIndex >= promptBreakdown.length - 1) return;
    setActivePrompt(promptBreakdown[activePromptIndex + 1]);
  }, [activePromptIndex, promptBreakdown]);

  // focus close on open, return focus to the prompt card on close so keyboard
  // users resume where they were. only fires on the open/close transitions so
  // cycling prev/next inside the modal doesn't yank focus mid-browse.
  useEffect(() => {
    const open = activePrompt != null;
    const wasOpen = modalWasOpenRef.current;
    modalWasOpenRef.current = open;
    if (open && !wasOpen) {
      const id = window.requestAnimationFrame(() => {
        modalCloseRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    if (!open && wasOpen) {
      const trigger = lastPromptTriggerRef.current;
      lastPromptTriggerRef.current = null;
      if (trigger && document.contains(trigger)) {
        trigger.focus();
      }
    }
  }, [activePrompt]);

  useEffect(() => {
    buildCacheRef.current = buildCache;
  }, [buildCache]);

  useEffect(() => {
    const requestId = ++activeRequestRef.current;

    if (!activeBuildId || !activeBuildMeta) {
      setActiveBuildError(null);
      setActiveBuildProgress(null);
      setActiveStreamingBuild(null);
      return;
    }

    if (buildCacheRef.current[activeBuildId]) {
      setActiveBuildError(null);
      setActiveBuildProgress({
        receivedBlocks: activeBuildMeta.blockCount,
        totalBlocks: activeBuildMeta.blockCount,
      });
      setActiveStreamingBuild(null);
      return;
    }

    const controller = new AbortController();
    setActiveBuildError(null);
    setActiveBuildProgress({
      receivedBlocks: 0,
      totalBlocks: activeBuildMeta.blockCount || null,
    });
    setActiveStreamingBuild(null);

    void fetchBuildVariantStream(
      {
        buildId: activeBuildId,
        variant: "full",
        checksum: null,
      },
      {
        signal: controller.signal,
        onProgress: (progressiveBuild, progress) => {
          if (activeRequestRef.current !== requestId) return;
          setActiveBuildProgress({
            receivedBlocks: progress.receivedBlocks,
            totalBlocks: progress.totalBlocks,
          });

          if (progress.receivedBlocks <= 0) return;
          setActiveStreamingBuild({
            buildId: activeBuildId,
            voxelBuild: progressiveBuild,
            gridSize: activeBuildMeta.gridSize,
            palette: activeBuildMeta.palette,
            mode: activeBuildMeta.mode,
            blockCount: progress.receivedBlocks,
          });
        },
      },
    )
      .then((payload) => {
        if (activeRequestRef.current !== requestId) return;
        const loadedBuild: LoadedPromptBuild = {
          buildId: activeBuildId,
          voxelBuild: payload.voxelBuild,
          gridSize: activeBuildMeta.gridSize,
          palette: activeBuildMeta.palette,
          mode: activeBuildMeta.mode,
          blockCount: Math.max(activeBuildMeta.blockCount, payload.voxelBuild.blocks.length),
        };

        setBuildCache((current) => {
          if (current[loadedBuild.buildId]) return current;
          return { ...current, [loadedBuild.buildId]: loadedBuild };
        });
        setActiveStreamingBuild(null);
        setActiveBuildProgress({
          receivedBlocks: loadedBuild.blockCount,
          totalBlocks: loadedBuild.blockCount,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        if (activeRequestRef.current !== requestId) return;
        setActiveBuildError(error instanceof Error ? error.message : "Failed to load build");
        setActiveStreamingBuild(null);
      });

    return () => {
      controller.abort();
    };
  }, [activeBuildId, activeBuildMeta]);

  return (
    <div className="mx-auto w-full max-w-[90rem] space-y-3.5 pb-10 sm:space-y-4 sm:pb-14">
      <section
        className="mb-panel mb-card-enter relative isolate overflow-hidden p-4 before:hidden sm:p-5"
        style={{ animationDelay: "0ms" }}
      >
        <div className="relative z-[1] space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Link
              href="/leaderboard"
              aria-label="Back to leaderboard"
              className="mb-eyebrow -my-2 inline-flex items-center gap-1.5 py-2 transition-colors duration-150 hover:text-fg focus-visible:text-fg focus-visible:outline-none"
            >
              <svg
                className="h-3 w-3"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10 4L6 8L10 12" />
              </svg>
              <span>Leaderboard</span>
            </Link>
            <span className="mb-eyebrow ml-auto sm:order-3">{data.model.provider}</span>
            <div className="basis-full sm:order-2 sm:flex sm:basis-auto sm:flex-1 sm:justify-center">
              <ModelLateralNav currentKey={data.model.key} modalOpen={activePrompt != null} />
            </div>
          </div>

          <div className="space-y-4">
            {/* Hero name + meta in a single flex row. On wide screens the meta
               pushes to the far right at the name's baseline so the dead
               space next to the display-type is used; on mobile it wraps
               underneath. */}
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
              <h1 className="max-w-[18ch] font-display text-[2.1rem] font-semibold leading-[0.96] tracking-[-0.02em] text-fg sm:text-[3.2rem]">
                {data.model.displayName}
              </h1>
              {/* Colorized meta — stability takes its colored dot+word, the
                 record W–L–D becomes three tinted tokens so you can read
                 the result at a glance instead of parsing one gray string. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 font-mono text-[11px] text-muted2 sm:ml-auto sm:justify-end">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${
                      data.model.stability === "Stable"
                        ? "bg-success"
                        : data.model.stability === "Established"
                          ? "bg-accent"
                          : "bg-warn"
                    }`}
                  />
                  <span
                    className={`capitalize ${stabilityTextClass(data.model.stability)}`}
                  >
                    {data.model.stability}
                  </span>
                </span>
                <span className="text-muted/30">·</span>
                <span className="inline-flex items-baseline gap-1">
                  <span className="text-muted">Record</span>
                  <span className="text-success">{data.model.winCount}</span>
                  <span className="text-muted/40">–</span>
                  <span className="text-danger">{voteSummary.decisiveLossCount}</span>
                  <span className="text-muted/40">–</span>
                  <span className="text-muted">{data.model.drawCount}</span>
                </span>
                <span className="text-muted/30">·</span>
                <span>
                  <span className="text-accent">{decisiveVotes.toLocaleString()}</span>{" "}
                  decisive votes
                </span>
                {data.model.bothBadCount > 0 ? (
                  <>
                    <span className="text-muted/30">·</span>
                    <span>
                      <span className="text-warn">
                        {data.model.bothBadCount.toLocaleString()}
                      </span>{" "}
                      both-bad
                    </span>
                  </>
                ) : null}
              </div>
            </div>

              {/* Flat 8-metric grid — the canonical source of this page's
                 stats. Recent form + Momentum were living in a separate
                 signal-snapshot panel; consolidated here so we don't have
                 two competing stat layouts. */}
              {/* Flat typographic grid — no boxes. Separators come from the
                 shared label row + subtle dividers between columns so the
                 eye reads them as one rhythm of numbers instead of eight
                 identical cards. */}
              <div className="mb-metric-row">
                <MetricTile
                  label="Rank score"
                  tone="text-accent"
                  value={
                    <AnimatedNumber
                      value={data.model.rankScore}
                      format={(v) => Math.round(v).toLocaleString()}
                    />
                  }
                  sub={`Raw ${Math.round(data.model.eloRating).toLocaleString()}`}
                />
                <MetricTile
                  label="Confidence"
                  value={
                    <AnimatedNumber
                      value={data.model.confidence}
                      format={(v) => `${Math.round(v)}%`}
                    />
                  }
                  sub={`RD ${Math.round(data.model.ratingDeviation)}`}
                />
                <MetricTile
                  label="Coverage"
                  value={
                    <AnimatedNumber
                      value={coveragePercent}
                      format={(v) => `${Math.round(v)}%`}
                    />
                  }
                  sub={coverageLabel}
                />
                <MetricTile
                  label="Win rate"
                  tone={winRateTone(data.summary.winRate)}
                  value={
                    <AnimatedNumber
                      value={data.summary.winRate == null ? null : data.summary.winRate * 100}
                      format={(v) => `${Math.round(v)}%`}
                    />
                  }
                />
                <MetricTile
                  label="Spread"
                  value={
                    <AnimatedNumber
                      value={
                        data.summary.scoreSpread == null ? null : data.summary.scoreSpread * 100
                      }
                      format={(v) => `${Math.round(v)}%`}
                    />
                  }
                />
                <MetricTile
                  label="Votes"
                  value={
                    <AnimatedNumber
                      value={data.summary.totalVotes}
                      format={(v) => Math.round(v).toLocaleString()}
                    />
                  }
                />
                <MetricTile
                  label="Recent form"
                  value={
                    <AnimatedNumber
                      value={
                        data.summary.recentForm == null ? null : data.summary.recentForm * 100
                      }
                      format={(v) => `${Math.round(v)}%`}
                    />
                  }
                />
                <MetricTile
                  label="Momentum"
                  tone={momentumTone(data.summary.recentDelta)}
                  leading={<MomentumArrow delta={data.summary.recentDelta} />}
                  value={
                    data.summary.recentDelta == null ? (
                      "-"
                    ) : (
                      <AnimatedNumber
                        value={data.summary.recentDelta * 100}
                        format={(v) => {
                          const sign = v > 0 ? "+" : "";
                          return `${sign}${v.toFixed(1)}%`;
                        }}
                      />
                    )
                  }
                />
              </div>
            </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.34fr_0.66fr] xl:gap-4">
        <section
          id="spread-curve"
          className="mb-panel mb-card-enter overflow-hidden p-4 before:hidden sm:p-5"
          style={{ animationDelay: "50ms" }}
        >
          <div className="space-y-3.5">
            {/* Custom header — SectionHeader inlined so the consistency gauge
               can sit next to it as contextual aside. Gauge here instead of
               in the hero because consistency is a summary of this curve's
               flatness; the two belong together, not in separate panels. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted">Distribution</div>
                <div className="text-[1.12rem] font-semibold leading-tight text-fg">
                  Prompt spread curve
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted2">
                  {promptCurveValues.length > 0
                    ? `${promptCurveValues.length} prompts · ${formatPercent(strongestCurveScore)} → ${formatPercent(weakestCurveScore)}`
                    : "Waiting for prompt data"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <ConsistencyGauge value={data.summary.consistency} size={72} />
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-muted">
                    Consistency
                  </span>
                  <span className="text-[11px] text-muted2">
                    {consistencyLabel(data.summary.consistency)}
                  </span>
                </div>
              </div>
            </div>
            {/* Chart: accent-to-accent2 stroke stays here — this is the one
               place the bi-color encodes real meaning (strongest→weakest).
               No outer card — the SVG's own plot-area rect is container
               enough; the nested ring was the second-order box we kept
               tripping over. */}
            <div className="pt-1">
                {curve.points.length > 0 ? (
                  <div>
                    {/* Inner wrapper sized exactly to the SVG so the absolute
                       dot buttons position against a height that matches the
                       plotted area — not against the legend's extra height. */}
                    <div className="relative h-[284px]">
                      <svg
                        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                        preserveAspectRatio="none"
                        className="h-full w-full"
                        role="img"
                        aria-label="Prompt spread curve from strongest to weakest prompts"
                      >
                      <defs>
                        <linearGradient
                          id="mb-profile-curve-line"
                          x1="0%"
                          y1="0%"
                          x2="100%"
                          y2="0%"
                        >
                          <stop offset="0%" stopColor="hsl(var(--accent) / 0.96)" />
                          <stop offset="100%" stopColor="hsl(var(--accent2) / 0.96)" />
                        </linearGradient>
                        <linearGradient
                          id="mb-profile-curve-area"
                          x1="0%"
                          y1="0%"
                          x2="0%"
                          y2="100%"
                        >
                          <stop offset="0%" stopColor="hsl(var(--accent2) / 0.24)" />
                          <stop offset="100%" stopColor="hsl(var(--accent) / 0.02)" />
                        </linearGradient>
                      </defs>

                      <rect
                        x={CHART_PAD_LEFT}
                        y={CHART_PAD_TOP}
                        width={CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT}
                        height={CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM}
                        rx={10}
                        fill="hsl(var(--card) / 0.32)"
                      />

                      {[0, 1, 2, 3, 4].map((tick) => {
                        const y =
                          CHART_PAD_TOP +
                          ((CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM) * tick) / 4;
                        return (
                          <line
                            key={`h-${tick}`}
                            x1={CHART_PAD_LEFT}
                            x2={CHART_WIDTH - CHART_PAD_RIGHT}
                            y1={y}
                            y2={y}
                            stroke="hsl(var(--border) / 0.36)"
                            strokeWidth={1}
                          />
                        );
                      })}

                      {[0, 1, 2, 3, 4].map((tick) => {
                        const x =
                          CHART_PAD_LEFT +
                          ((CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT) * tick) / 4;
                        return (
                          <line
                            key={`v-${tick}`}
                            x1={x}
                            x2={x}
                            y1={CHART_PAD_TOP}
                            y2={CHART_HEIGHT - CHART_PAD_BOTTOM}
                            stroke="hsl(var(--border) / 0.2)"
                            strokeWidth={1}
                          />
                        );
                      })}

                      <path
                        d={curve.areaPath}
                        fill="url(#mb-profile-curve-area)"
                        className="mb-curve-area-fade"
                      />
                      <path
                        d={curve.linePath}
                        fill="none"
                        stroke="url(#mb-profile-curve-line)"
                        strokeWidth={3.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        pathLength={1}
                        className="mb-curve-line-draw"
                      />

                      <circle
                        cx={curve.points[0]?.x}
                        cy={curve.points[0]?.y}
                        r={4.5}
                        fill="hsl(var(--accent) / 0.95)"
                        stroke="hsl(var(--bg))"
                        strokeWidth={2}
                        className="mb-curve-endpoint"
                      />
                      <circle
                        cx={curve.points[curve.points.length - 1]?.x}
                        cy={curve.points[curve.points.length - 1]?.y}
                        r={4.5}
                        fill="hsl(var(--warn) / 0.95)"
                        stroke="hsl(var(--bg))"
                        strokeWidth={2}
                        className="mb-curve-endpoint"
                      />
                    </svg>

                    {curve.points.map((point, index) => (
                      <button
                        key={`curve-point-${index}`}
                        type="button"
                        aria-label={`Prompt rank ${index + 1}, score ${formatPercent(point.value)}`}
                        onMouseEnter={() => setHoveredCurveIndex(index)}
                        onMouseLeave={() =>
                          setHoveredCurveIndex((current) => (current === index ? null : current))
                        }
                        onFocus={() => setHoveredCurveIndex(index)}
                        onBlur={() =>
                          setHoveredCurveIndex((current) => (current === index ? null : current))
                        }
                        className="absolute z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-fg/20 bg-bg/10 transition duration-200 motion-safe:will-change-transform hover:scale-125 hover:border-accent/55 hover:bg-accent/18 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                        style={{
                          left: `${((point.x / CHART_WIDTH) * 100).toFixed(3)}%`,
                          top: `${((point.y / CHART_HEIGHT) * 100).toFixed(3)}%`,
                        }}
                      >
                        <span className="sr-only">Show prompt detail</span>
                      </button>
                    ))}

                    {hoveredPoint && hoveredPrompt ? (
                      <div
                        className={`mb-curve-tooltip absolute z-20 ${tooltipAlignClass}`}
                        style={{
                          left: `${((hoveredPoint.x / CHART_WIDTH) * 100).toFixed(3)}%`,
                          top: `calc(${((hoveredPoint.y / CHART_HEIGHT) * 100).toFixed(3)}% - 10px)`,
                        }}
                      >
                        <div className="font-mono text-fg">
                          {formatPercent(hoveredPrompt.averageScore)}
                        </div>
                        <div className="max-w-[18rem] overflow-hidden text-ellipsis whitespace-nowrap text-muted">
                          {hoveredPrompt.promptText}
                        </div>
                        <div className="mt-0.5 whitespace-nowrap text-[10px] text-muted">
                          rank #{hoveredCurveIndex != null ? hoveredCurveIndex + 1 : "-"} •{" "}
                          {hoveredPrompt.votes} votes
                        </div>
                      </div>
                    ) : null}
                    </div>

                    <div className="mt-2 flex items-center justify-between text-xs text-muted">
                      <span>Strongest prompts</span>
                      <span>Median</span>
                      <span>Weakest prompts</span>
                    </div>
                  </div>
                ) : (
                  <div className="py-10 text-center text-sm text-muted">
                    Not enough prompt signal yet.
                  </div>
                )}
              </div>
          </div>
        </section>

        <section
          id="prompt-highs-lows"
          className="mb-panel mb-card-enter overflow-hidden p-4 before:hidden sm:p-5"
          style={{ animationDelay: "90ms" }}
        >
          <div className="space-y-3.5">
            <SectionHeader eyebrow="Signal edges" title="Prompt highs and lows" />
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <div className="flex items-center justify-between border-b border-border/40 pb-2">
                  <span className="text-xs uppercase tracking-[0.12em] text-muted">Strongest</span>
                  <span className="font-mono text-xs text-success">
                    {formatPercent(bestPromptScore)}
                  </span>
                </div>
                <div className="divide-y divide-border/30">
                  {strongest.slice(0, 3).map((prompt, index) => (
                    <PromptEdgeRow
                      key={prompt.promptId}
                      prompt={prompt}
                      rank={index + 1}
                      tone="strong"
                      delayMs={140 + index * 35}
                    />
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between border-b border-border/40 pb-2">
                  <span className="text-xs uppercase tracking-[0.12em] text-muted">Weakest</span>
                  <span className="font-mono text-xs text-danger">
                    {formatPercent(weakPromptScore)}
                  </span>
                </div>
                <div className="divide-y divide-border/30">
                  {weakest.slice(0, 3).map((prompt, index) => (
                    <PromptEdgeRow
                      key={prompt.promptId}
                      prompt={prompt}
                      rank={index + 1}
                      tone="weak"
                      delayMs={240 + index * 35}
                    />
                  ))}
                </div>
              </div>
            </div>

            {strongest.length === 0 && weakest.length === 0 ? (
              <div className="text-sm text-muted">Not enough signal yet.</div>
            ) : null}
          </div>
        </section>
      </div>

      <section
        id="head-to-head"
        className="mb-panel mb-card-enter overflow-hidden p-4 before:hidden sm:p-5"
        style={{ animationDelay: "130ms" }}
      >
        <div className="space-y-3.5">
          <SectionHeader
            eyebrow="Matchups"
            title="Head-to-head"
            meta={`${data.opponents.length} opponents`}
          />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {visibleOpponents.map((opponent) => (
              <HeadToHeadCard key={opponent.key} opponent={opponent} />
            ))}
            {opponents.length === 0 ? (
              <div className="text-sm text-muted xl:col-span-3">Not enough signal yet.</div>
            ) : null}
          </div>
          {hasHiddenOpponents ? (
            <div className="flex justify-center pt-0.5">
              <button
                type="button"
                aria-expanded={showAllOpponents}
                className="mb-collapse-toggle"
                onClick={() => setShowAllOpponents((current) => !current)}
              >
                {showAllOpponents ? "Hide full context" : "View full context"}
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section
        id="prompt-breakdown"
        className="mb-panel mb-card-enter overflow-hidden p-4 before:hidden sm:p-5"
        style={{ animationDelay: "170ms" }}
      >
        <div className="space-y-3.5">
          <SectionHeader
            eyebrow="Per prompt"
            title="Prompt breakdown"
            meta="Ranked by score"
          />

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {visiblePromptBreakdown.map((prompt, index) => {
              const voteDensity = prompt.votes / maxPromptVotes;
              return (
                <article
                  key={prompt.promptId}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open prompt details for ${prompt.promptText}`}
                  onClick={(event) => {
                    lastPromptTriggerRef.current = event.currentTarget;
                    setActivePrompt(prompt);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    lastPromptTriggerRef.current = event.currentTarget;
                    setActivePrompt(prompt);
                  }}
                  className="relative mb-card-enter h-full cursor-pointer rounded-2xl bg-bg/40 p-3.5 ring-1 ring-border/60 transition duration-200 hover:-translate-y-0.5 hover:bg-bg/55 hover:ring-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="inline-flex items-center rounded-full bg-bg/60 px-2 py-0.5 font-mono text-[10px] text-muted ring-1 ring-border/65">
                        #{index + 1}
                      </div>
                      <div className="mt-2 mb-clamp-prompt-tight text-sm text-fg/92">
                        {prompt.promptText}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm text-fg">
                        {formatPercent(prompt.averageScore)}
                      </div>
                      <div className="text-xs text-muted">{prompt.votes} votes</div>
                    </div>
                  </div>

                  <div className="mt-2.5 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/40">
                        <div
                          className={`h-full rounded-full ${scoreBarClass(prompt.averageScore)}`}
                          style={{
                            width: `${Math.max(0, Math.min(100, prompt.averageScore * 100)).toFixed(1)}%`,
                          }}
                        />
                      </div>
                      <span className="w-10 text-right text-[11px] text-muted">score</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/30">
                        <div
                          className="h-full rounded-full bg-fg/35"
                          style={{ width: `${(clamp01(voteDensity) * 100).toFixed(1)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right text-[11px] text-muted">volume</span>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex flex-wrap items-center gap-1 font-mono text-[11px]">
                      <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-success">
                        W {prompt.wins}
                      </span>
                      <span className="rounded-full bg-danger/12 px-1.5 py-0.5 text-danger">
                        L {prompt.losses}
                      </span>
                      <span className="rounded-full bg-bg/55 px-1.5 py-0.5 text-muted">
                        D {prompt.draws}
                      </span>
                      {prompt.bothBad > 0 ? (
                        <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-danger/85">
                          B {prompt.bothBad}
                        </span>
                      ) : null}
                      {prompt.build ? (
                        <span className="rounded-full bg-bg/55 px-1.5 py-0.5 text-muted">
                          {prompt.build.blockCount.toLocaleString()} blocks
                        </span>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}

            {promptBreakdown.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted xl:col-span-2">
                Not enough signal yet.
              </div>
            ) : null}
          </div>
          {hasHiddenPrompts ? (
            <div className="flex justify-center pt-0.5">
              <button
                type="button"
                aria-expanded={showAllPrompts}
                className="mb-collapse-toggle"
                onClick={() => setShowAllPrompts((current) => !current)}
              >
                {showAllPrompts ? "Hide full context" : "View full context"}
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {activePrompt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-bg/60 backdrop-blur-sm"
            onClick={() => setActivePrompt(null)}
          />
          <div
            ref={modalSurfaceRef}
            role="dialog"
            aria-modal="true"
            aria-label="Full prompt details"
            className="relative w-full max-w-3xl overflow-hidden rounded-3xl bg-card/92 shadow-soft ring-1 ring-border backdrop-blur-xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3 sm:gap-3 sm:px-4">
              <PromptLateralNav
                index={activePromptIndex}
                total={promptBreakdown.length}
                onPrev={handlePromptPrev}
                onNext={handlePromptNext}
                enabled={activePrompt != null}
                surfaceRef={modalSurfaceRef}
              />
              <button
                type="button"
                ref={modalCloseRef}
                className="mb-btn mb-btn-ghost h-9 shrink-0 rounded-full px-3 text-xs sm:px-4"
                onClick={() => setActivePrompt(null)}
                aria-label="Close prompt details"
              >
                <svg
                  className="h-4 w-4 sm:hidden"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
                <span className="hidden sm:inline">Close</span>
                <span className="ml-1.5 hidden sm:inline">
                  <span className="mb-kbd">Esc</span>
                </span>
              </button>
            </div>

            <div className="max-h-[min(86vh,1060px)] space-y-3.5 overflow-auto px-4 py-4">
              <div data-no-swipe>
                <PromptBuildPreview
                  build={activeLoadedBuild}
                  loading={isActiveBuildLoading}
                  loadingLabel={activeBuildLoadingLabel}
                  loadingProgress={activeBuildProgress}
                  error={activeBuildError}
                  heightClass="h-[min(62vh,580px)] min-h-[18rem]"
                  viewerRef={modalViewerRef}
                  actions={
                    modalExportTargets.length > 0 ? (
                      <SandboxGifExportButton
                        targets={modalExportTargets}
                        promptText={activePrompt.promptText}
                        iconOnly
                        label="Export GIF"
                      />
                    ) : null
                  }
                  overlay={
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg/88 via-bg/56 to-transparent p-2.5">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-bg/76 px-2.5 py-1 font-mono text-[10px] text-muted ring-1 ring-border/75">
                        <span>
                          <span className="text-fg/85">{activePrompt.votes}</span>{" "}
                          <span className="text-muted/70">votes</span>
                        </span>
                        <span className="text-muted/40">·</span>
                        <span>
                          <span className="text-fg/85">
                            {formatPercent(activePrompt.averageScore)}
                          </span>{" "}
                          <span className="text-muted/70">score</span>
                        </span>
                        {activePrompt.build ? (
                          <>
                            <span className="text-muted/40">·</span>
                            <span>
                              <span className="text-fg/85">
                                {activePrompt.build.blockCount.toLocaleString()}
                              </span>{" "}
                              <span className="text-muted/70">blocks</span>
                            </span>
                          </>
                        ) : null}
                      </span>
                    </div>
                  }
                />
              </div>
              <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-fg/92">
                {activePrompt.promptText}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
