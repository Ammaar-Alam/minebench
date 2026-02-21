"use client";

import dynamic from "next/dynamic";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { summarizeArenaVotes } from "@/lib/arena/voteMath";
import type { VoxelBuild } from "@/lib/voxel/types";

const CHART_WIDTH = 900;
const CHART_HEIGHT = 304;
const CHART_PAD_LEFT = 28;
const CHART_PAD_RIGHT = 24;
const CHART_PAD_TOP = 16;
const CHART_PAD_BOTTOM = 34;
const HERO_MOTIF_WIDTH = 1100;
const HERO_MOTIF_HEIGHT = 154;
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
  if (score >= 0.66) return "from-success/85 to-accent/85";
  if (score >= 0.5) return "from-accent/85 to-accent2/85";
  if (score >= 0.35) return "from-warn/85 to-accent2/78";
  return "from-danger/85 to-warn/78";
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

function buildHeroMotif(values: number[]): { linePath: string; areaPath: string } {
  if (values.length === 0) return { linePath: "", areaPath: "" };

  const padX = 28;
  const padTop = 48;
  const padBottom = 28;
  const innerWidth = HERO_MOTIF_WIDTH - padX * 2;
  const innerHeight = HERO_MOTIF_HEIGHT - padTop - padBottom;
  const denom = Math.max(1, values.length - 1);

  const points = values.map((value, index) => ({
    x: padX + (index / denom) * innerWidth,
    y: padTop + (1 - clamp01(value)) * innerHeight,
  }));

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");

  const baselineY = HERO_MOTIF_HEIGHT - padBottom;
  const first = points[0];
  const last = points[points.length - 1];
  const areaPath = [
    `M ${first.x.toFixed(2)} ${baselineY.toFixed(2)}`,
    ...points.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
    `L ${last.x.toFixed(2)} ${baselineY.toFixed(2)}`,
    "Z",
  ].join(" ");

  return { linePath, areaPath };
}

function MetricTile({
  label,
  value,
  sub,
  tone = "text-fg",
  valueClassName = "text-[1.72rem] font-semibold leading-tight tracking-tight",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  valueClassName?: string;
}) {
  return (
    <div className="mb-metric-tile">
      <div className="text-[10px] uppercase tracking-[0.11em] text-muted">{label}</div>
      <div className={`mt-0.5 ${valueClassName} ${tone}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

function ConsistencyGauge({ value, label }: { value: number | null; label: string }) {
  const safe = Math.max(0, Math.min(100, value ?? 0));
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - safe / 100);

  return (
    <div className="relative h-[148px] w-[148px] shrink-0">
      <svg viewBox="0 0 160 160" className="h-full w-full">
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          stroke="hsl(var(--border) / 0.45)"
          strokeWidth="9"
        />
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          stroke="url(#mb-consistency-ring)"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${circumference.toFixed(2)} ${circumference.toFixed(2)}`}
          strokeDashoffset={offset.toFixed(2)}
          transform="rotate(-90 80 80)"
        />
        <defs>
          <linearGradient id="mb-consistency-ring" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="hsl(var(--accent) / 0.95)" />
            <stop offset="100%" stopColor="hsl(var(--accent2) / 0.96)" />
          </linearGradient>
        </defs>
      </svg>
      <div className="pointer-events-none absolute inset-[14px] flex flex-col items-center justify-center gap-1">
        <div className={`text-[1.65rem] font-semibold leading-none ${consistencyTone(value)}`}>
          {value != null ? `${value}` : "-"}
        </div>
        <div className="mt-0.5 text-[7px] uppercase tracking-[0.19em] text-muted">{label}</div>
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
    <article className="mb-head-to-head-card mb-sheen-surface group">
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
    </article>
  );
}

const PromptBuildPreview = memo(function PromptBuildPreview({
  build,
  loading = false,
  loadingLabel,
  error = null,
  heightClass = "h-44",
}: {
  build: LoadedPromptBuild | null;
  loading?: boolean;
  loadingLabel?: string;
  error?: string | null;
  heightClass?: string;
}) {
  if (loading && !build) {
    return (
      <div className={`relative flex w-full items-center justify-center overflow-hidden rounded-xl bg-bg/42 ring-1 ring-border/65 ${heightClass}`}>
        <div className="text-xs text-muted">{loadingLabel ?? "Retrieving build..."}</div>
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
        voxelBuild={build.voxelBuild}
        palette={build.palette}
        autoRotate
        showControls={false}
      />
      {loading ? (
        <div className="pointer-events-none absolute left-2.5 top-2.5 rounded-md border border-border/70 bg-bg/72 px-2.5 py-1.5 text-[11px] text-muted backdrop-blur-sm">
          {loadingLabel ?? "Retrieving build..."}
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg/88 via-bg/56 to-transparent p-2.5">
        <span className="inline-flex items-center rounded-full bg-bg/76 px-2 py-0.5 font-mono text-[10px] text-muted ring-1 ring-border/75">
          {build.blockCount.toLocaleString()} blocks
        </span>
      </div>
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
  const heroMotif = useMemo(() => buildHeroMotif(promptCurveValues), [promptCurveValues]);
  const strongestCurveScore = promptCurveValues[0] ?? null;
  const weakestCurveScore = promptCurveValues[promptCurveValues.length - 1] ?? null;
  const medianCurveScore =
    promptCurveValues.length > 0
      ? promptCurveValues[Math.floor((promptCurveValues.length - 1) / 2)]
      : null;

  const bestPromptScore = strongest[0]?.averageScore ?? null;
  const weakPromptScore = weakest[0]?.averageScore ?? null;
  const voteSummary = summarizeArenaVotes(data.model);
  const recordText = `${data.model.winCount}-${voteSummary.decisiveLossCount}-${data.model.drawCount}`;
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
  const promptBuildCount = promptBreakdown.filter((prompt) => prompt.build != null).length;
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
  const activeBuildLoadingLabel = useMemo(() => {
    const total = activeBuildProgress?.totalBlocks ?? null;
    const received = activeBuildProgress?.receivedBlocks ?? 0;
    if (!total || total <= 0) {
      if (received > 0) return `Retrieving build ${received.toLocaleString()} blocks`;
      return "Retrieving build...";
    }
    const pct = Math.max(1, Math.min(99, Math.round((received / total) * 100)));
    return `Retrieving build ${pct}%`;
  }, [activeBuildProgress]);
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
        className="mb-panel mb-card-enter relative isolate overflow-hidden bg-gradient-to-br from-card/84 via-card/72 to-card/58 p-3.5 sm:p-4"
        style={{ animationDelay: "30ms" }}
      >
        <div aria-hidden="true" className="mb-hero-spread pointer-events-none absolute inset-0" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(44rem_22rem_at_8%_0%,hsl(var(--accent)/0.15),transparent_66%),radial-gradient(38rem_19rem_at_96%_0%,hsl(var(--accent2)/0.16),transparent_64%)]"
        />
        {heroMotif.linePath ? (
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${HERO_MOTIF_WIDTH} ${HERO_MOTIF_HEIGHT}`}
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-x-0 top-2 h-[116px] w-full opacity-60 motion-safe:opacity-85"
            style={{ mixBlendMode: "screen" }}
          >
            <defs>
              <linearGradient id="mb-hero-motif-line" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="hsl(var(--accent) / 0.52)" />
                <stop offset="100%" stopColor="hsl(var(--accent2) / 0.50)" />
              </linearGradient>
              <linearGradient id="mb-hero-motif-area" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="hsl(var(--accent2) / 0.16)" />
                <stop offset="100%" stopColor="hsl(var(--accent) / 0.00)" />
              </linearGradient>
            </defs>
            <path d={heroMotif.areaPath} fill="url(#mb-hero-motif-area)" />
            <path
              d={heroMotif.linePath}
              fill="none"
              stroke="url(#mb-hero-motif-line)"
              strokeWidth={2.2}
              strokeLinecap="round"
            />
          </svg>
        ) : null}

        <div className="mb-panel-inner relative z-[1] space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/leaderboard" aria-label="Back to leaderboard" className="mb-back-link">
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M10 4L6 8L10 12" />
                </svg>
              </Link>
            </div>
            <div
              className="mb-model-reveal mb-model-reveal-in rounded-full bg-bg/62 ring-border/75"
              style={{ animationDelay: "90ms" }}
            >
              <span className="text-fg">{data.model.provider}</span>
            </div>
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.9fr)] xl:items-stretch xl:gap-3">
            <div className="space-y-3">
              <h1 className="max-w-[20ch] font-display text-[2.3rem] font-semibold leading-[0.94] tracking-[-0.02em] text-fg sm:text-[3.7rem]">
                {data.model.displayName}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <div className="mb-model-stat-pill mb-model-stat-pill-neutral mb-model-reveal mb-model-reveal-in">
                  <span className="font-mono text-[13px] font-semibold">
                    {data.model.stability}
                  </span>
                </div>
                <div className="mb-model-stat-pill mb-model-stat-pill-success mb-model-reveal mb-model-reveal-in">
                  <span className="font-mono text-[13px] font-semibold">Record {recordText}</span>
                </div>
                <div
                  className="mb-model-stat-pill mb-model-stat-pill-neutral mb-model-reveal mb-model-reveal-in"
                  style={{ animationDelay: "55ms" }}
                >
                  <span className="font-mono text-[13px] font-semibold">
                    Decisive {decisiveVotes.toLocaleString()}
                  </span>
                </div>
                <div
                  className="mb-model-stat-pill mb-model-stat-pill-danger mb-model-reveal mb-model-reveal-in"
                  style={{ animationDelay: "95ms" }}
                >
                  <span className="font-mono text-[13px] font-semibold">
                    Both bad {data.model.bothBadCount.toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="rounded-[1.2rem] bg-gradient-to-br from-accent/[0.09] via-transparent to-accent2/[0.12] p-px">
                <div className="rounded-[1.12rem] bg-bg/45 p-1.5 ring-1 ring-border/70">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <MetricTile
                      label="Rank score"
                      value={`${Math.round(data.model.rankScore)}`}
                      sub={`Raw ${Math.round(data.model.eloRating)}`}
                    />
                    <MetricTile
                      label="Confidence"
                      value={`${data.model.confidence}%`}
                      sub={`RD ${Math.round(data.model.ratingDeviation)}`}
                    />
                    <MetricTile label="Coverage" value={`${coveragePercent}%`} sub={coverageLabel} />
                    <MetricTile label="Win rate" value={formatPercent(data.summary.winRate)} />
                    <MetricTile label="Spread" value={formatPercent(data.summary.scoreSpread)} />
                    <MetricTile label="Votes" value={data.summary.totalVotes.toLocaleString()} />
                    <MetricTile
                      label="Stability"
                      value={data.model.stability}
                      valueClassName="text-[1.2rem] font-semibold leading-tight tracking-tight"
                      tone={
                        data.model.stability === "Stable"
                          ? "text-success"
                          : data.model.stability === "Established"
                            ? "text-accent"
                            : "text-warn"
                      }
                    />
                    <MetricTile
                      label="Quality floor"
                      value={formatPercent(data.summary.qualityFloorScore)}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="mb-profile-snapshot self-stretch h-full rounded-2xl bg-gradient-to-b from-card/82 to-card/50 p-3 ring-1 ring-white/12 shadow-[0_36px_52px_-52px_hsl(220_40%_2%_/_1)] backdrop-blur-sm sm:p-3.5 flex flex-col justify-between gap-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
                Signal snapshot
              </div>
              <div className="mt-2.5 flex-1">
                <div className="grid auto-rows-min items-start gap-3 sm:grid-cols-[auto_1fr] sm:gap-3">
                  <ConsistencyGauge value={data.summary.consistency} label="Consistency" />
                  <div className="grid auto-rows-min grid-cols-2 gap-2">
                    <div className="min-h-[68px] rounded-xl bg-card/65 px-3 py-2.5 ring-1 ring-border/55">
                      <div className="text-[11px] text-muted">Best prompt</div>
                      <div className="font-mono text-base text-success">
                        {formatPercent(bestPromptScore)}
                      </div>
                    </div>
                    <div className="min-h-[68px] rounded-xl bg-card/65 px-3 py-2.5 ring-1 ring-border/55">
                      <div className="text-[11px] text-muted">Weakest prompt</div>
                      <div className="font-mono text-base text-danger">
                        {formatPercent(weakPromptScore)}
                      </div>
                    </div>
                    <div className="min-h-[68px] rounded-xl bg-card/65 px-3 py-2.5 ring-1 ring-border/55">
                      <div className="text-[11px] text-muted">Recent form</div>
                      <div className="font-mono text-base text-fg">
                        {formatPercent(data.summary.recentForm)}
                      </div>
                    </div>
                    <div className="min-h-[68px] rounded-xl bg-card/65 px-3 py-2.5 ring-1 ring-border/55">
                      <div className="text-[11px] text-muted">Momentum</div>
                      <div
                        className={`font-mono text-base ${
                          data.summary.recentDelta == null
                            ? "text-muted"
                            : data.summary.recentDelta >= 0
                              ? "text-success"
                              : "text-danger"
                        }`}
                      >
                        {formatSignedPercent(data.summary.recentDelta)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-xs text-muted">
                {consistencyLabel(data.summary.consistency)}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.34fr_0.66fr] xl:gap-4">
        <section
          id="spread-curve"
          className="mb-panel mb-section-shell mb-card-enter overflow-hidden p-3.5 sm:p-4"
          style={{ animationDelay: "90ms" }}
        >
          <div className="mb-panel-inner space-y-3">
            <SectionHeader
              eyebrow="Distribution"
              title="Prompt spread curve"
              meta={
                promptCurveValues.length > 0
                  ? `${promptCurveValues.length} ranked prompts`
                  : "Waiting for prompt data"
              }
            />
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="rounded-xl bg-gradient-to-b from-bg/60 to-bg/42 px-3 py-2 ring-1 ring-border/65">
                <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Strongest</div>
                <div className="font-mono text-sm text-success">
                  {formatPercent(strongestCurveScore)}
                </div>
              </div>
              <div className="rounded-xl bg-gradient-to-b from-bg/60 to-bg/42 px-3 py-2 ring-1 ring-border/65">
                <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Median</div>
                <div className="font-mono text-sm text-fg">{formatPercent(medianCurveScore)}</div>
              </div>
              <div className="rounded-xl bg-gradient-to-b from-bg/60 to-bg/42 px-3 py-2 ring-1 ring-border/65">
                <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Weakest</div>
                <div className="font-mono text-sm text-danger">
                  {formatPercent(weakestCurveScore)}
                </div>
              </div>
            </div>
            <div className="rounded-[1.1rem] bg-gradient-to-br from-accent/14 via-transparent to-accent2/14 p-px">
              <div className="rounded-2xl bg-bg/45 p-3 ring-1 ring-border/70 sm:p-3.5">
                {curve.points.length > 0 ? (
                  <div className="relative">
                    <svg
                      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                      preserveAspectRatio="none"
                      className="h-[284px] w-full"
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

                      <path d={curve.areaPath} fill="url(#mb-profile-curve-area)" />
                      <path
                        d={curve.linePath}
                        fill="none"
                        stroke="url(#mb-profile-curve-line)"
                        strokeWidth={3.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />

                      <circle
                        cx={curve.points[0]?.x}
                        cy={curve.points[0]?.y}
                        r={4.5}
                        fill="hsl(var(--accent) / 0.95)"
                        stroke="hsl(var(--bg))"
                        strokeWidth={2}
                      />
                      <circle
                        cx={curve.points[curve.points.length - 1]?.x}
                        cy={curve.points[curve.points.length - 1]?.y}
                        r={4.5}
                        fill="hsl(var(--warn) / 0.95)"
                        stroke="hsl(var(--bg))"
                        strokeWidth={2}
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
          </div>
        </section>

        <section
          id="prompt-highs-lows"
          className="mb-panel mb-section-shell mb-card-enter overflow-hidden p-3.5 sm:p-4"
          style={{ animationDelay: "130ms" }}
        >
          <div className="mb-panel-inner space-y-3">
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
        className="mb-panel mb-section-shell mb-card-enter overflow-hidden p-3.5 sm:p-4"
        style={{ animationDelay: "170ms" }}
      >
        <div className="mb-panel-inner space-y-3">
          <SectionHeader
            eyebrow="Matchups"
            title="Head-to-head"
            meta={`${data.opponents.length} opponents`}
          />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {visibleOpponents.map((opponent, index) => (
              <div
                key={opponent.key}
                className="mb-card-enter"
                style={{ animationDelay: `${180 + index * 26}ms` }}
              >
                <HeadToHeadCard opponent={opponent} />
              </div>
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
        className="mb-panel mb-section-shell mb-card-enter overflow-hidden p-3.5 sm:p-4"
        style={{ animationDelay: "210ms" }}
      >
        <div className="mb-panel-inner space-y-3">
          <SectionHeader
            eyebrow="Per prompt"
            title="Prompt breakdown"
            meta="Ranked by score"
          />

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {promptBreakdown.length > 0 ? (
              <article
                className="mb-breakdown-summary mb-card-enter xl:col-span-2"
                style={{ animationDelay: "230ms" }}
              >
                <div className="mb-breakdown-summary-head">
                  <div className="text-[10px] uppercase tracking-[0.15em] text-muted">
                    At a glance
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="mb-breakdown-summary-tile">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-muted">
                      Strongest
                    </div>
                    <div className="font-mono text-sm text-success">
                      {formatPercent(bestPromptScore)}
                    </div>
                  </div>
                  <div className="mb-breakdown-summary-tile">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Median</div>
                    <div className="font-mono text-sm text-fg">
                      {formatPercent(medianCurveScore)}
                    </div>
                  </div>
                  <div className="mb-breakdown-summary-tile">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-muted">
                      Weakest
                    </div>
                    <div className="font-mono text-sm text-danger">
                      {formatPercent(weakPromptScore)}
                    </div>
                  </div>
                  <div className="mb-breakdown-summary-tile">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-muted">
                      Builds
                    </div>
                    <div className="font-mono text-sm text-fg">{promptBuildCount}</div>
                  </div>
                </div>
              </article>
            ) : null}
            {visiblePromptBreakdown.map((prompt, index) => {
              const voteDensity = prompt.votes / maxPromptVotes;
              return (
                <article
                  key={prompt.promptId}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open prompt details for ${prompt.promptText}`}
                  onClick={() => setActivePrompt(prompt)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setActivePrompt(prompt);
                  }}
                  className="relative mb-card-enter h-full cursor-pointer rounded-2xl bg-gradient-to-b from-bg/56 to-bg/40 p-3.5 ring-1 ring-border/70 transition-all duration-200 hover:-translate-y-0.5 hover:ring-accent/45 hover:from-bg/62 hover:to-bg/44 hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:p-4"
                  style={{ animationDelay: `${240 + index * 18}ms` }}
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
                          className={`h-full rounded-full bg-gradient-to-r ${scoreBarClass(prompt.averageScore)}`}
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
            role="dialog"
            aria-modal="true"
            aria-label="Full prompt details"
            className="relative w-full max-w-3xl overflow-hidden rounded-3xl bg-card/92 shadow-soft ring-1 ring-border backdrop-blur-xl"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <div className="mb-badge">
                <span className="mb-dot" />
                <span className="text-fg">Prompt</span>
              </div>
              <button
                type="button"
                className="mb-btn mb-btn-ghost h-9 rounded-full px-4 text-xs"
                onClick={() => setActivePrompt(null)}
              >
                Close <span className="hidden sm:inline"><span className="mb-kbd">Esc</span></span>
              </button>
            </div>

            <div className="max-h-[76vh] space-y-3 overflow-auto px-4 py-4">
              <PromptBuildPreview
                build={activeLoadedBuild}
                loading={isActiveBuildLoading}
                loadingLabel={activeBuildLoadingLabel}
                error={activeBuildError}
                heightClass="h-56 sm:h-64"
              />
              <div className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
                <span>{activePrompt.votes} votes</span>
                <span>•</span>
                <span>{formatPercent(activePrompt.averageScore)} score</span>
                {activePrompt.build ? (
                  <>
                    <span>•</span>
                    <span>{activePrompt.build.blockCount.toLocaleString()} blocks</span>
                  </>
                ) : null}
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
