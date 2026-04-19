"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArenaBuildDeliveryClass,
  ArenaBuildRef,
  ArenaBuildVariant,
  ArenaMatchup,
  ArenaBuildStreamEvent,
  VoteChoice,
} from "@/lib/arena/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { formatVoxelLoadingMessage } from "@/components/voxel/VoxelLoadingHud";
import { VoteBar, type VoteConfirmTarget } from "@/components/arena/VoteBar";
import { AnimatedPrompt } from "@/components/arena/AnimatedPrompt";
import { ModelReveal } from "@/components/arena/ModelReveal";
import { ErrorState } from "@/components/ErrorState";
import { trackEvent } from "@/lib/analytics";

type ArenaState =
  | { kind: "loading" }
  | { kind: "ready"; matchup: ArenaMatchup }
  | { kind: "error"; message: string };

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

async function readErrorResponse(res: Response, fallback: string): Promise<string> {
  // Categorize common statuses so the UI isn't showing a raw HTML error page.
  const statusHint =
    res.status === 429
      ? "Slow down — you're going a bit fast. Try again in a few seconds."
      : res.status === 503 || res.status === 504
        ? "The server is overloaded right now. Please try again shortly."
        : res.status >= 500
          ? "The server had a problem. Please try again."
          : res.status === 404
            ? "Not found."
            : res.status === 401 || res.status === 403
              ? "You don't have access to this."
              : null;

  // Best-effort body extraction: JSON { error | message } → string, else truncated text.
  let detail: string | null = null;
  try {
    const body = await res.clone().json();
    if (body && typeof body === "object") {
      const candidate = (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message;
      if (typeof candidate === "string" && candidate.trim()) detail = candidate.trim();
    }
  } catch {
    // not JSON — fall through to text
  }
  if (!detail) {
    try {
      const text = (await res.text()).trim();
      // Skip raw HTML error pages
      if (text && !text.startsWith("<") && text.length <= 500) detail = text;
    } catch {
      // ignore
    }
  }

  if (statusHint && detail && detail !== statusHint) return `${statusHint} (${detail})`;
  return statusHint ?? detail ?? fallback;
}

async function fetchMatchupOnce(promptId?: string, signal?: AbortSignal): Promise<ArenaMatchup> {
  const url = new URL("/api/arena/matchup", window.location.origin);
  if (promptId) url.searchParams.set("promptId", promptId);
  // Adaptive mode keeps small builds instant while deferring large payloads.
  url.searchParams.set("payload", "adaptive");
  const res = await fetch(url, { method: "GET", credentials: "include", signal });
  if (!res.ok) throw new Error(await readErrorResponse(res, "Failed to load matchup"));
  return (await res.json()) as ArenaMatchup;
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

async function submitVote(matchupId: string, choice: VoteChoice) {
  // hard timeout so a stalled /api/arena/vote call can't hang the reveal state
  const timed = makeTimeoutSignal(undefined, VOTE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("/api/arena/vote", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchupId, choice }),
      signal: timed.signal,
    });
    if (!res.ok) throw new Error(await readErrorResponse(res, "Couldn't record your vote."));
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Vote timed out — the site may be under heavy load. Please try again.");
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

type BuildVariantResponse = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
  serverValidated: boolean;
  buildLoadHints?: ArenaMatchup["a"]["buildLoadHints"];
  voxelBuild: ArenaMatchup["a"]["build"];
};

type BuildStreamProgress = {
  receivedBlocks: number;
  totalBlocks: number | null;
  chunkIndex: number | null;
  chunkCount: number | null;
};

type FetchBuildVariantStreamOptions = {
  signal?: AbortSignal;
  onProgress?: (build: ArenaMatchup["a"]["build"], progress: BuildStreamProgress) => void;
};

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
const INITIAL_RETRIEVAL_OVERLAY_DELAY_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_INITIAL_RETRIEVAL_OVERLAY_DELAY_MS ?? "420",
  10,
);
const CLIENT_BUILD_CACHE_MAX_ENTRIES = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_CLIENT_BUILD_CACHE_MAX_ENTRIES ?? "8",
  10,
);
const CLIENT_BUILD_CACHE_MAX_EST_BYTES = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_CLIENT_BUILD_CACHE_MAX_EST_BYTES ?? "60000000",
  10,
);

type CachedHydratedBuild = {
  build: NonNullable<ArenaMatchup["a"]["build"]>;
  serverValidated: boolean;
  variant: ArenaBuildVariant;
  buildLoadHints?: ArenaMatchup["a"]["buildLoadHints"];
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
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      signal: timed.signal,
    });
    if (!res.ok) throw new Error(await readErrorResponse(res, "Couldn't load build"));
    return (await res.json()) as BuildVariantResponse;
  } finally {
    timed.cleanup();
  }
}

function parseArenaBuildStreamLine(line: string): ArenaBuildStreamEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as ArenaBuildStreamEvent;
  } catch {
    return null;
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
      credentials: "include",
      signal: requestTimed.signal,
    });
  } finally {
    requestTimed.cleanup();
  }
  if (!res.ok) throw new Error(await readErrorResponse(res, "Couldn't load build"));

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
    let buildLoadHints: ArenaMatchup["a"]["buildLoadHints"] | undefined;
    let totalBlocks: number | null = null;
    let hasComplete = false;
    let sawFirstEvent = false;

    const streamedBlocks: NonNullable<ArenaMatchup["a"]["build"]>["blocks"] = [];

    const emitProgress = (progress: BuildStreamProgress) => {
      if (!opts?.onProgress) return;
      opts.onProgress(
        {
          version: "1.0",
          blocks: streamedBlocks,
        },
        progress,
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
              ? build.blocks.length
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
};

function laneNeedsFullHydration(lane: ArenaMatchup["a"]): boolean {
  if (!lane.buildLoadHints || lane.buildLoadHints.initialVariant !== "preview") return false;
  // Before the preview payload is present, we're still doing the initial retrieval (not the "upgrade to full").
  if (!lane.build) return false;
  const full = lane.buildLoadHints.fullBlockCount ?? 0;
  if (!Number.isFinite(full) || full <= 0) return false;
  return lane.build.blocks.length < full;
}

function isMatchupBuildLoading(matchup: ArenaMatchup, sideState: SideLoadState | null): boolean {
  if (!matchup.a.build || !matchup.b.build) return true;
  // Treat preview lanes as still loading until the full payload is hydrated.
  // (If preview is identical to full, `laneNeedsFullHydration` returns false so we don't block the UI.)
  if (laneNeedsFullHydration(matchup.a) || laneNeedsFullHydration(matchup.b)) return true;
  if (!sideState || sideState.matchupId !== matchup.id) return false;
  return sideState.a !== "idle" || sideState.b !== "idle";
}

function getInitialHydrateRef(matchup: ArenaMatchup, side: "a" | "b"): ArenaBuildRef | null {
  const lane = matchup[side];
  if (lane.build) return null;
  // Start with the server-selected initial variant (preview for huge builds),
  // then hydrate full automatically in the background.
  const initialVariant = lane.buildLoadHints?.initialVariant ?? "full";
  if (initialVariant === "preview") return lane.previewRef ?? lane.buildRef ?? null;
  return lane.buildRef ?? lane.previewRef ?? null;
}

function getHydratedBuildCacheKey(ref: ArenaBuildRef): string {
  return `${ref.buildId}:${ref.variant}:${ref.checksum ?? "none"}`;
}

function isHeavyRetrievalDeliveryClass(
  deliveryClass: ArenaBuildDeliveryClass | undefined,
): boolean {
  return deliveryClass === "stream-live" || deliveryClass === "stream-artifact";
}

function shouldHydrateViaSnapshot(
  deliveryClass: ArenaBuildDeliveryClass | undefined,
): boolean {
  return deliveryClass === "snapshot";
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
    lane.build.blocks.length < fullBlockCount
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
  return `${ref.buildId}:${variant}:${checksum}:${lane.build.blocks.length}`;
}

function estimateCachedHydratedBuildBytes(entry: CachedHydratedBuild): number {
  if (entry.variant === "preview") {
    return Math.max(1, entry.build.blocks.length * 34);
  }
  const estimated = entry.buildLoadHints?.fullEstimatedBytes;
  if (typeof estimated === "number" && Number.isFinite(estimated) && estimated > 0) {
    return Math.floor(estimated);
  }
  return Math.max(1, entry.build.blocks.length * 34);
}

function formatBuildLoadingMessage(
  fullLoading: boolean,
  progress: SideLoadProgress | null,
): string {
  return formatVoxelLoadingMessage(fullLoading ? "Retrieving full build" : "Retrieving build", progress);
}

type RevealAction = VoteChoice | "SKIP";

type RevealState =
  | { kind: "none" }
  | {
      kind: "reveal";
      matchupId: string;
      action: RevealAction;
      startedAt: number;
      advanceAt: number;
      next: ArenaMatchup | null;
    };

const REVEAL_MS_AFTER_VOTE = 2600;
const REVEAL_MS_AFTER_SKIP = 1600;
const TRANSITION_OUT_MS = 220;
const BUILD_STUCK_AUTOSKIP_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_BUILD_STUCK_AUTOSKIP_MS ?? "45000",
  10,
);

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
  const [transitioning, setTransitioning] = useState(false);
  const [mobileBuildView, setMobileBuildView] = useState<"a" | "b">("a");
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  const [, forceTick] = useState(0);
  const stateRef = useRef<ArenaState>({ kind: "loading" });
  const submittingRef = useRef(false);
  const transitioningStateRef = useRef(false);
  const cardsScrollRef = useRef<HTMLDivElement | null>(null);
  const revealRef = useRef<RevealState>({ kind: "none" });
  const transitionRef = useRef(false);
  const hydrateInFlightRef = useRef(new Set<string>());
  const hydratedBuildCacheRef = useRef(new Map<string, CachedHydratedBuild>());
  const sideLoadStateRef = useRef<SideLoadState | null>(null);
  const viewerReadyRef = useRef<{ matchupId: string; a: boolean; b: boolean } | null>(null);
  const autoAdvanceTimeoutRef = useRef<number | null>(null);
  const stuckAutoSkipTimeoutRef = useRef<number | null>(null);
  const advanceNowRequestedAtRef = useRef<number | null>(null);
  const handleVoteRef = useRef<(choice: VoteChoice) => Promise<void>>(
    async () => undefined
  );
  const handleSkipRef = useRef<() => Promise<void>>(async () => undefined);
  const advanceToNextRef = useRef<(matchupId: string, next: ArenaMatchup) => Promise<void>>(
    async () => undefined
  );

	  const setLaneLoadPhase = useCallback((matchupId: string, side: "a" | "b", phase: SideLoadPhase) => {
	    setSideLoadState((prev) => {
	      if (!prev) return prev;
      if (prev.matchupId !== matchupId) return prev;
      if (prev[side] === phase) return prev;
      const progressKey = side === "a" ? "aProgress" : "bProgress";
      const overlayKey = side === "a" ? "aOverlayVisible" : "bOverlayVisible";
      return {
        ...prev,
        [side]: phase,
        [overlayKey]: phase === "idle" ? false : prev[overlayKey],
        [progressKey]: phase === "idle" ? null : prev[progressKey],
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

  const matchup = state.kind === "ready" ? state.matchup : null;
  const revealModels = Boolean(matchup && reveal.kind === "reveal" && reveal.matchupId === matchup.id);
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
  }, [matchup?.id]);

  useEffect(() => {
    const el = cardsScrollRef.current;
    if (!el) return;
    // New matchup should always start at Build A on mobile.
    setMobileBuildView("a");
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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [promptDialogOpen]);

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
    setMobileBuildView(side);
    el.scrollTo({ left, behavior });
  }, []);

  function sleepMs(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  const cacheHydratedBuild = useCallback((ref: ArenaBuildRef, entry: CachedHydratedBuild) => {
    if (estimateCachedHydratedBuildBytes(entry) > CLIENT_BUILD_CACHE_MAX_EST_BYTES) {
      return;
    }

    const cache = hydratedBuildCacheRef.current;
    const key = getHydratedBuildCacheKey(ref);
    if (cache.has(key)) cache.delete(key);
    cache.set(key, entry);

    const maxEntries =
      Number.isFinite(CLIENT_BUILD_CACHE_MAX_ENTRIES) && CLIENT_BUILD_CACHE_MAX_ENTRIES > 0
        ? CLIENT_BUILD_CACHE_MAX_ENTRIES
        : 8;
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }, []);

  const readHydratedBuildFromCache = useCallback((ref: ArenaBuildRef): CachedHydratedBuild | null => {
    const cache = hydratedBuildCacheRef.current;
    const touch = (key: string) => {
      const hit = cache.get(key) ?? null;
      if (!hit) return null;
      cache.delete(key);
      cache.set(key, hit);
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
        receivedBlocks: cached.build.blocks.length,
        totalBlocks: cached.build.blocks.length,
      });
      setLaneLoadPhase(matchupValue.id, side, "idle");
      setLaneOverlayVisible(matchupValue.id, side, false);
      return;
    }

    const key = `${matchupValue.id}:${side}:${target}:${ref.variant}:${ref.buildId}:${ref.checksum ?? "none"}`;
    if (hydrateInFlightRef.current.has(key)) return;
    hydrateInFlightRef.current.add(key);
    setLaneLoadPhase(matchupValue.id, side, target === "full" ? "loading-full" : "loading-initial");
    setLaneLoadProgress(matchupValue.id, side, { receivedBlocks: 0, totalBlocks: null });

    let overlayTimer: number | null = null;
    const showOverlayImmediately =
      target === "full" ||
      isHeavyRetrievalDeliveryClass(lane.buildLoadHints?.deliveryClass) ||
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

    const APPLY_PROGRESS_MIN_MS = 90;
    const APPLY_PROGRESS_MIN_BLOCKS = 12_000;
    const enableProgressiveUpdates = target === "initial" || !lane.build;
    let lastAppliedAt = 0;
    let lastAppliedBlocks = 0;

    const applyProgressiveBuild = (
      progressiveBuild: ArenaMatchup["a"]["build"],
      progress: BuildStreamProgress,
    ) => {
      setLaneLoadProgress(matchupValue.id, side, {
        receivedBlocks: progress.receivedBlocks,
        totalBlocks: progress.totalBlocks,
      });
      if (progress.receivedBlocks <= 0) return;
      if (!enableProgressiveUpdates) return;
      const now = performance.now();
      const shouldApply =
        progress.totalBlocks != null && progress.receivedBlocks >= progress.totalBlocks
          ? true
          : now - lastAppliedAt >= APPLY_PROGRESS_MIN_MS ||
            progress.receivedBlocks - lastAppliedBlocks >= APPLY_PROGRESS_MIN_BLOCKS;
      if (!shouldApply) return;

      lastAppliedAt = now;
      lastAppliedBlocks = progress.receivedBlocks;

      setState((prev) => {
        if (prev.kind !== "ready") return prev;
        if (prev.matchup.id !== matchupValue.id) return prev;
        return {
          kind: "ready",
          matchup: withHydratedBuild(
            prev.matchup,
            side,
            progressiveBuild,
            true,
            ref.variant,
            ref,
          ),
        };
      });
    };

    try {
      const hydrationStartedAt = performance.now();
      const payload = shouldHydrateViaSnapshot(lane.buildLoadHints?.deliveryClass)
        ? await fetchBuildVariantSnapshot(ref, opts?.signal)
        : await fetchBuildVariantStream(ref, {
            signal: opts?.signal,
            onProgress: applyProgressiveBuild,
          });
      const hydrationMs = performance.now() - hydrationStartedAt;
      const resolvedRef: ArenaBuildRef = {
        buildId: payload.buildId || ref.buildId,
        variant: payload.variant ?? ref.variant,
        checksum: payload.checksum ?? ref.checksum ?? null,
      };
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
          receivedBlocks: payload.voxelBuild.blocks.length,
          totalBlocks: payload.voxelBuild.blocks.length,
        });
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
      if (!opts?.silent) {
        console.warn("arena full build hydration failed", err);
      }
    } finally {
      if (overlayTimer != null) window.clearTimeout(overlayTimer);
      hydrateInFlightRef.current.delete(key);
      setLaneOverlayVisible(matchupValue.id, side, false);
      setLaneLoadProgress(matchupValue.id, side, null);
      setLaneLoadPhase(matchupValue.id, side, "idle");
    }
  }, [
    cacheHydratedBuild,
    readHydratedBuildFromCache,
    setLaneLoadPhase,
    setLaneLoadProgress,
    setLaneOverlayVisible,
  ]);

  const prefetchMatchupBuilds = useCallback(
    (matchupValue: ArenaMatchup) => {
      for (const side of ["a", "b"] as const) {
        void hydrateMatchupSide(matchupValue, side, "initial", { silent: true });
      }
    },
    [hydrateMatchupSide],
  );

  useEffect(() => {
    if (reveal.kind !== "reveal") return;
    const id = window.setInterval(() => forceTick((t) => t + 1), 120);
    return () => window.clearInterval(id);
  }, [reveal.kind, revealModels]);

  useEffect(() => {
    return () => {
      clearAutoAdvance();
      clearStuckAutoSkip();
    };
  }, []);

  useEffect(() => {
    // AbortController lets us actually cancel the in-flight fetchMatchup
    // when reloadToken bumps (retry click). /api/arena/matchup is
    // side-effecting — it creates a matchup row + increments shownCount —
    // so silently ignoring a stale response would still let the previous
    // request run to completion on the server, burning matchups with no
    // vote signal. Aborting short-circuits the network round-trip so at
    // least the response body parse + any follow-up is cancelled.
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

    const controller = new AbortController();

    for (const side of hydrateSides) {
      void hydrateMatchupSide(current, side, "initial", { signal: controller.signal, silent: true });
    }

    return () => {
      controller.abort();
    };
  }, [hydrateMatchupSide, matchup?.id]);

  // If the initial variant is a preview (huge builds), start hydrating full as soon as
  // the preview is in place so users always end up with full fidelity automatically.
  useEffect(() => {
    const current =
      stateRef.current.kind === "ready" ? stateRef.current.matchup : null;
    if (!current) return;

    for (const side of ["a", "b"] as const) {
      const lane = current[side];
      if (!lane.build) continue;
      if (lane.buildLoadHints?.initialVariant !== "preview") continue;
      if (!lane.buildRef) continue;

      // If preview is effectively identical to full (e.g. full is under the preview cap),
      // there's nothing to "upgrade" and we should not block the lane on full hydration.
      const fullBlockCount = lane.buildLoadHints?.fullBlockCount ?? lane.build.blocks.length;
      if (lane.build.blocks.length >= fullBlockCount) continue;

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
    if (!isMatchupBuildLoading(matchup, sideLoadState)) return;
    if (!Number.isFinite(BUILD_STUCK_AUTOSKIP_MS) || BUILD_STUCK_AUTOSKIP_MS <= 0) return;
    if (submittingRef.current) return;

    stuckAutoSkipTimeoutRef.current = window.setTimeout(() => {
      const current = stateRef.current;
      if (current.kind !== "ready") return;
      if (current.matchup.id !== matchup.id) return;
      if (!isMatchupBuildLoading(current.matchup, sideLoadStateRef.current)) return;
      if (submittingRef.current) return;
      void handleSkipRef.current();
    }, BUILD_STUCK_AUTOSKIP_MS);

    return () => {
      clearStuckAutoSkip();
    };
  }, [matchup, sideLoadState]);

  const revealMeta = (() => {
    if (!matchup || reveal.kind !== "reveal" || reveal.matchupId !== matchup.id) {
      return {
        visible: false,
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
    return { visible: true, secondsLeft, progress, nextReady, waitingForNext };
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
    if (current.kind !== "reveal" || current.matchupId !== matchupId) return;
    const now = Date.now();
    advanceNowRequestedAtRef.current = now;
    setReveal((prev) => {
      if (prev.kind !== "reveal" || prev.matchupId !== matchupId) return prev;
      // Clamp so the timer UI switches to "Loading next…" immediately.
      return { ...prev, advanceAt: Math.min(prev.advanceAt, now) };
    });
    if (current.next) {
      void advanceToNextRef.current(matchupId, current.next);
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

  async function handleVote(choice: VoteChoice) {
    if (!matchup || submitting) return;
    if (isMatchupBuildLoading(matchup, sideLoadStateRef.current)) return;
    const viewer = viewerReadyRef.current;
    if (!viewer || viewer.matchupId !== matchup.id || !viewer.a || !viewer.b) return;
    flashVoteConfirm(choice);
    setSubmitting(true);
    clearAutoAdvance();
    advanceNowRequestedAtRef.current = null;
    const startedAt = Date.now();
    const advanceAt = startedAt + REVEAL_MS_AFTER_VOTE;
    setReveal({ kind: "reveal", matchupId: matchup.id, action: choice, startedAt, advanceAt, next: null });

    // Submit the vote first. If it fails, stay on the current matchup so
    // the user can retry — advancing anyway would silently convert a
    // dropped vote into a skip and bias rankings + prompt coverage. We
    // also don't fetch the next matchup (which would burn a shownCount
    // row with no vote signal).
    try {
      await submitVote(matchup.id, choice);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't record your vote.";
      flashVoteWarning(msg);
      setReveal({ kind: "none" });
      setSubmitting(false);
      return;
    }

    try {
      const next = applyCachedBuildsToMatchup(await fetchMatchup(undefined));
      prefetchMatchupBuilds(next);
      const stillRevealing = revealRef.current.kind === "reveal" && revealRef.current.matchupId === matchup.id;
      if (stillRevealing) {
        const requestedAt = advanceNowRequestedAtRef.current;
        const effectiveAdvanceAt =
          typeof requestedAt === "number" && Number.isFinite(requestedAt) ? Math.min(advanceAt, requestedAt) : advanceAt;
        setReveal((prev) =>
          prev.kind === "reveal" && prev.matchupId === matchup.id
            ? { ...prev, next, advanceAt: effectiveAdvanceAt }
            : prev,
        );
        scheduleAutoAdvance(matchup.id, effectiveAdvanceAt, next);
      } else {
        setState((prev) => {
          if (prev.kind === "ready" && prev.matchup.id !== matchup.id) return prev;
          if (prev.kind === "error") return prev;
          return { kind: "ready", matchup: next };
        });
        setSubmitting(false);
      }
    } catch (err) {
      // Vote already persisted; this is a pure next-matchup load failure,
      // so show the full error state (nothing to present next).
      clearAutoAdvance();
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Couldn't load the next matchup",
      });
      setReveal({ kind: "none" });
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    if (!matchup || submitting) return;
    flashVoteConfirm("SKIP");
    setSubmitting(true);
    try {
      clearAutoAdvance();
      advanceNowRequestedAtRef.current = null;
      const startedAt = Date.now();
      const advanceAt = startedAt + REVEAL_MS_AFTER_SKIP;
      setReveal({ kind: "reveal", matchupId: matchup.id, action: "SKIP", startedAt, advanceAt, next: null });
      const next = applyCachedBuildsToMatchup(await fetchMatchup(undefined));
      prefetchMatchupBuilds(next);
      const stillRevealing = revealRef.current.kind === "reveal" && revealRef.current.matchupId === matchup.id;
      if (stillRevealing) {
        const requestedAt = advanceNowRequestedAtRef.current;
        const effectiveAdvanceAt =
          typeof requestedAt === "number" && Number.isFinite(requestedAt) ? Math.min(advanceAt, requestedAt) : advanceAt;
        setReveal((prev) =>
          prev.kind === "reveal" && prev.matchupId === matchup.id
            ? { ...prev, next, advanceAt: effectiveAdvanceAt }
            : prev,
        );
        scheduleAutoAdvance(matchup.id, effectiveAdvanceAt, next);
      } else {
        setState((prev) => {
          if (prev.kind === "ready" && prev.matchup.id !== matchup.id) return prev;
          if (prev.kind === "error") return prev;
          return { kind: "ready", matchup: next };
        });
        setSubmitting(false);
      }
    } catch (err) {
      clearAutoAdvance();
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load matchup",
      });
      setReveal({ kind: "none" });
      setSubmitting(false);
    } finally {
      // `submitting` stays true through the reveal so users can see the model names.
    }
  }

  handleVoteRef.current = handleVote;
  handleSkipRef.current = handleSkip;
  advanceToNextRef.current = advanceToNext;

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
        !viewersReady || isMatchupBuildLoading(currentMatchup, sideLoadStateRef.current);

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
  const viewerState =
    matchup && viewerReady && viewerReady.matchupId === matchup.id ? viewerReady : null;
  const viewerReadyA = Boolean(viewerState?.a);
  const viewerReadyB = Boolean(viewerState?.b);
  const laneNeedsFullA = Boolean(matchup && laneNeedsFullHydration(matchup.a));
  const laneNeedsFullB = Boolean(matchup && laneNeedsFullHydration(matchup.b));
  const buildAUpgradePending = Boolean(matchup && laneLoadA === "idle" && laneNeedsFullA);
  const buildBUpgradePending = Boolean(matchup && laneLoadB === "idle" && laneNeedsFullB);

  const matchupBuildLoading = Boolean(
    matchup && (isMatchupBuildLoading(matchup, sideLoadState) || !viewerReadyA || !viewerReadyB),
  );

  const buildARetrieving =
    state.kind === "loading" ||
    Boolean(
      matchup &&
        (!matchup.a.build ||
          laneLoadA !== "idle" ||
          buildAUpgradePending),
    );
  const buildBRetrieving =
    state.kind === "loading" ||
    Boolean(
      matchup &&
        (!matchup.b.build ||
          laneLoadB !== "idle" ||
          buildBUpgradePending),
    );
  const buildAPlacing = Boolean(matchup && matchup.a.build && laneLoadA === "idle" && !viewerReadyA);
  const buildBPlacing = Boolean(matchup && matchup.b.build && laneLoadB === "idle" && !viewerReadyB);
  const buildALoading = buildARetrieving || buildAPlacing;
  const buildBLoading = buildBRetrieving || buildBPlacing;
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
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="mb-panel flex flex-col gap-2 p-2.5 sm:p-4 md:gap-2.5 md:p-3">
          {/* prompt */}
          <div className="mb-subpanel relative overflow-hidden px-3 py-2.5 sm:px-4 sm:py-3 md:py-2.5">
            <div className="relative z-10 flex items-center gap-3 sm:gap-3.5">
              <span className="mb-eyebrow shrink-0">Prompt</span>
              <div
                title={promptText}
                className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ellipsis pr-1 text-[14px] font-medium leading-tight text-fg/95 sm:text-[15px] ${isLongPrompt ? "cursor-help" : ""}`}
              >
                <AnimatedPrompt text={promptText || "Loading…"} isExpanded={false} />
              </div>
              {isLongPrompt ? (
                <button
                  type="button"
                  className="mb-btn mb-btn-ghost h-8 shrink-0 rounded-full px-3 text-[11px] sm:text-[11px]"
                  title="View full prompt"
                  onClick={() => setPromptDialogOpen(true)}
                >
                  <span className="hidden sm:inline">Full prompt</span>
                  <span className="sm:hidden">Full</span>
                </button>
              ) : null}
            </div>
            {isLongPrompt ? (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-0 w-16 bg-gradient-to-l from-bg/95 to-transparent md:w-20" />
            ) : null}
          </div>

          {promptDialogOpen ? (
            <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
              <button
                type="button"
                aria-label="Close"
                className="absolute inset-0 bg-bg/60 backdrop-blur-sm"
                onClick={() => setPromptDialogOpen(false)}
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Full prompt"
                className="relative w-full max-w-2xl overflow-hidden rounded-3xl bg-card/90 shadow-soft ring-1 ring-border backdrop-blur-xl"
              >
                <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                  <span className="mb-eyebrow">Prompt</span>
                  <button
                    type="button"
                    className="mb-btn mb-btn-ghost h-9 rounded-full px-4 text-xs"
                    onClick={() => setPromptDialogOpen(false)}
                  >
                    Close <span className="hidden sm:inline"><span className="mb-kbd">Esc</span></span>
                  </button>
                </div>
                <div className="max-h-[70vh] overflow-auto px-4 py-4">
                  <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-fg/90">
                    {promptText}
                  </p>
                </div>
              </div>
            </div>
          ) : null}

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
              className="flex items-center gap-2 rounded-xl bg-bg/50 px-3 py-2 text-xs text-muted ring-1 ring-border/60"
            >
              <span className="mb-progress-wait relative h-1.5 w-6 overflow-hidden rounded-full bg-border/40" aria-hidden="true" />
              <span>Taking longer than usual — MineBench may be under heavy load.</span>
            </div>
          ) : null}

          {voteWarning ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 rounded-xl bg-warn/8 px-3 py-2 text-xs text-warn ring-1 ring-warn/30"
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
              className={`relative mb-card-enter min-w-full shrink-0 snap-center [scroll-snap-stop:always] rounded-2xl transition-all duration-200 ease-out motion-reduce:transition-none sm:rounded-3xl md:min-w-0 md:shrink md:snap-none ${mobileBuildView === "a" ? "ring-1 ring-accent/30 md:ring-border/60 md:shadow-none" : "ring-1 ring-border/60"} ${revealModels && revealAction === "A" ? "mb-reveal-highlight-a" : ""} ${revealModels && revealAction === "B" ? "mb-reveal-dim" : ""}`}
            >
              {/* swipe hint – only on mobile, points toward Build B */}
              <div className="pointer-events-none absolute right-2.5 top-2.5 z-10 flex items-center gap-1 md:hidden" aria-hidden="true">
                <span className="text-[9px] uppercase tracking-widest text-muted2/40">swipe</span>
                <span className="mb-swipe-arrow-right inline-block text-muted2/50">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4l4 4-4 4"/></svg>
                </span>
              </div>
              <VoxelViewerCard
                key={matchup ? `${matchup.id}:a` : "arena-build-a"}
                title="Build A"
                subtitle={
                  <ModelReveal
                    revealed={revealModels}
                    provider={matchup?.a.model.provider}
                    modelName={matchup?.a.model.displayName}
                  />
                }
                voxelBuild={matchup?.a.build ?? null}
                expectedBlockCount={matchup ? getExpectedBlocksForLane(matchup.a) : undefined}
                meshCacheKey={matchup ? getLaneMeshCacheKey(matchup.a) : null}
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
                isLoading={buildALoading}
                loadingMode={buildALoadingMode}
                loadingMessage={buildALoadingMessage}
                loadingProgress={laneProgressA ?? undefined}
                autoRotate={!isCoarsePointer || mobileBuildView === "a"}
                viewerSize="arena"
                actions={null}
              />
            </div>
            <div
              className={`relative mb-card-enter mb-card-enter-delay min-w-full shrink-0 snap-center [scroll-snap-stop:always] rounded-2xl transition-all duration-200 ease-out motion-reduce:transition-none sm:rounded-3xl md:min-w-0 md:shrink md:snap-none ${mobileBuildView === "b" ? "ring-1 ring-accent2/30 md:ring-border/60 md:shadow-none" : "ring-1 ring-border/60"} ${revealModels && revealAction === "B" ? "mb-reveal-highlight-b" : ""} ${revealModels && revealAction === "A" ? "mb-reveal-dim" : ""}`}
            >
              {/* swipe hint – only on mobile, points back toward Build A */}
              <div className="pointer-events-none absolute right-2.5 top-2.5 z-10 flex items-center gap-1 md:hidden" aria-hidden="true">
                <span className="mb-swipe-arrow-left inline-block text-muted2/50">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 4l-4 4 4 4"/></svg>
                </span>
                <span className="text-[9px] uppercase tracking-widest text-muted2/40">swipe</span>
              </div>
              <VoxelViewerCard
                key={matchup ? `${matchup.id}:b` : "arena-build-b"}
                title="Build B"
                subtitle={
                  <ModelReveal
                    revealed={revealModels}
                    provider={matchup?.b.model.provider}
                    modelName={matchup?.b.model.displayName}
                  />
                }
                voxelBuild={matchup?.b.build ?? null}
                expectedBlockCount={matchup ? getExpectedBlocksForLane(matchup.b) : undefined}
                meshCacheKey={matchup ? getLaneMeshCacheKey(matchup.b) : null}
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
                isLoading={buildBLoading}
                loadingMode={buildBLoadingMode}
                loadingMessage={buildBLoadingMessage}
                loadingProgress={laneProgressB ?? undefined}
                autoRotate={!isCoarsePointer || mobileBuildView === "b"}
                viewerSize="arena"
                actions={null}
              />
            </div>
          </div>

          {/* segmented build switcher – mobile only */}
          <div className="md:hidden">
            <div className="relative flex rounded-xl bg-bg/40 p-0.5 ring-1 ring-border/50">
              {/* sliding indicator */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[10px] bg-card/70 ring-1 ring-border/40 transition-transform duration-200 ease-out"
                style={{ transform: mobileBuildView === "b" ? "translateX(calc(100% + 4px))" : "translateX(0)" }}
              />
              <button
                type="button"
                aria-pressed={mobileBuildView === "a"}
                className={`relative z-10 flex-1 rounded-[10px] py-2 text-center font-mono text-[12px] font-medium uppercase tracking-[0.12em] transition-colors ${mobileBuildView === "a" ? "text-fg" : "text-muted2 hover:text-fg"}`}
                disabled={buildSwitchDisabled}
                onClick={() => scrollToMobileBuild("a")}
              >
                Build A
              </button>
              <button
                type="button"
                aria-pressed={mobileBuildView === "b"}
                className={`relative z-10 flex-1 rounded-[10px] py-2 text-center font-mono text-[12px] font-medium uppercase tracking-[0.12em] transition-colors ${mobileBuildView === "b" ? "text-fg" : "text-muted2 hover:text-fg"}`}
                disabled={buildSwitchDisabled}
                onClick={() => scrollToMobileBuild("b")}
              >
                Build B
              </button>
            </div>
          </div>

          {/* action bar (vote buttons ↔ reveal status) */}
          <div className="relative h-[8.5rem] sm:h-[7.5rem]">
            <div className="relative h-full">
              <div className="relative h-full">
                <div
                  className={`absolute inset-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${revealMeta.visible ? "pointer-events-none opacity-0 translate-y-1" : "opacity-100 translate-y-0"}`}
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
                    className={`absolute inset-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${revealMeta.visible ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 -translate-y-1"}`}
                  >
                    <div className="mb-subpanel h-full px-3 py-2 sm:px-4 sm:py-2.5">
                      <div className="flex h-full flex-col justify-between gap-2">
                        <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="mb-badge bg-bg/40 text-muted ring-border/60">
                              {revealAction === "SKIP"
                                ? "Skipped"
                                : revealAction === "TIE"
                                  ? "You voted: Tie"
                                  : revealAction === "BOTH_BAD"
                                    ? "You voted: Both bad"
                                    : revealAction === "A"
                                      ? "You voted: A"
                                      : revealAction === "B"
                                        ? "You voted: B"
                                        : "Revealed"}
                            </span>

                            <div className="hidden min-w-0 items-center gap-2 text-xs sm:flex">
                              <span className="inline-flex h-5 items-center rounded-full bg-accent/10 px-2 font-mono text-[11px] font-semibold text-accent ring-1 ring-accent/20">
                                A
                              </span>
                              <span className="min-w-0 max-w-[10rem] truncate font-medium text-fg md:max-w-[16rem]">
                                {matchup?.a.model.displayName}
                              </span>
                              <span className="text-muted">vs</span>
                              <span className="inline-flex h-5 items-center rounded-full bg-accent2/10 px-2 font-mono text-[11px] font-semibold text-accent2 ring-1 ring-accent2/20">
                                B
                              </span>
                              <span className="min-w-0 max-w-[10rem] truncate font-medium text-fg md:max-w-[16rem]">
                                {matchup?.b.model.displayName}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center justify-between gap-3 sm:shrink-0 sm:justify-start">
                            <div className="flex items-center gap-2 text-xs text-muted">
                              {revealMeta.nextReady ? (
                                <span className="font-mono">
                                  Next in {Math.max(0, Math.ceil(revealMeta.secondsLeft))}s
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-2 font-mono">
                                  <span
                                    className={`h-3 w-3 rounded-full border-2 border-muted/30 ${
                                      revealMeta.waitingForNext
                                        ? "animate-pulse border-t-muted/60"
                                        : "animate-spin border-t-muted/80"
                                    }`}
                                  />
                                  {revealMeta.waitingForNext
                                    ? "Loading next…"
                                    : "Loading…"}
                                </span>
                              )}
                            </div>

                            <button
                              type="button"
                              className="mb-btn mb-btn-ghost h-9 px-4 text-xs"
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
                              Next{" "}
                              <span className="hidden md:inline"><span className="mb-kbd">Space</span></span>
                            </button>
                          </div>
                        </div>

                        {/* Mobile-only: show both model names so user doesn't have to swipe */}
                        <div className="flex items-center gap-2 text-[11px] sm:hidden">
                          <div
                            className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-accent/8 px-2 py-1 ring-1 ring-accent/20 ${
                              revealAction === "A" ? "ring-accent/50" : ""
                            }`}
                          >
                            <span className="inline-flex h-4 items-center rounded-full bg-accent/15 px-1.5 font-mono text-[10px] font-semibold text-accent ring-1 ring-accent/30">
                              A
                            </span>
                            <span className="min-w-0 flex-1 truncate font-medium text-fg/95">
                              {matchup?.a.model.displayName ?? "—"}
                            </span>
                          </div>
                          <div
                            className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-accent2/8 px-2 py-1 ring-1 ring-accent2/20 ${
                              revealAction === "B" ? "ring-accent2/50" : ""
                            }`}
                          >
                            <span className="inline-flex h-4 items-center rounded-full bg-accent2/15 px-1.5 font-mono text-[10px] font-semibold text-accent2 ring-1 ring-accent2/30">
                              B
                            </span>
                            <span className="min-w-0 flex-1 truncate font-medium text-fg/95">
                              {matchup?.b.model.displayName ?? "—"}
                            </span>
                          </div>
                        </div>

                        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-border/40">
                          <div
                            className="h-full rounded-full bg-accent/70 transition-[width] duration-100 ease-linear motion-reduce:transition-none"
                            style={{ width: `${(revealMeta.progress * 100).toFixed(1)}%` }}
                          />
                          {revealMeta.waitingForNext ? (
                            <div className="mb-progress-wait absolute inset-0" />
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
      </div>

      {/* how it works — pipeline diagram */}
      <div className="mb-panel mb-panel-solid overflow-hidden p-5 sm:p-7 md:p-10">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
          <h2 className="mb-3 text-center font-display text-2xl font-semibold tracking-tight text-fg sm:text-[1.75rem] md:mb-4 md:text-3xl">
            How it works
          </h2>
          <p className="mb-8 max-w-2xl text-center text-[15px] leading-relaxed text-fg/80 sm:mb-10 sm:text-base">
            Models read a text prompt and output raw JSON coordinates for voxel blocks — no images,
            no 3D tools. Humans vote pair-wise and rankings emerge from Elo.
          </p>

          <div className="grid w-full grid-cols-1 items-stretch gap-5 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:gap-6">
            {/* 01 — Prompt */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="mb-step-num">01</span>
                <span className="mb-eyebrow">Prompt</span>
              </div>
              <figure className="rounded-xl border border-border/60 bg-bg/40 p-4 font-mono text-[12px] italic leading-relaxed text-fg/85">
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
              <figure className="relative rounded-xl border border-accent/25 bg-bg/40 p-4 font-mono text-[11px] leading-relaxed text-fg/85">
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
                <span className="absolute bottom-2 right-3 font-mono text-[10px] text-muted/70">
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
              <figure className="flex flex-col gap-3 rounded-xl border border-border/60 bg-bg/40 p-4">
                <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
                  <span className="inline-flex h-7 items-center rounded-lg bg-accent/15 px-2.5 font-semibold text-accent ring-1 ring-accent/30">
                    A wins
                  </span>
                  <span className="hidden text-muted/60 sm:inline">·</span>
                  <span className="inline-flex h-7 items-center rounded-lg bg-muted/10 px-2.5 font-semibold text-muted/90 ring-1 ring-border/70">
                    Tie
                  </span>
                  <span className="hidden text-muted/60 sm:inline">·</span>
                  <span className="inline-flex h-7 items-center rounded-lg bg-accent2/15 px-2.5 font-semibold text-accent2 ring-1 ring-accent2/30">
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
      </div>

      {/* sandbox cta - moved to bottom & polished */}
      <div className="mb-panel mb-panel-solid flex flex-col items-center gap-4 p-5 text-center sm:p-6 md:p-7">
        <div className="flex flex-col items-center gap-1.5">
          <h3 className="font-display text-lg font-semibold tracking-tight text-fg sm:text-xl">
            Want to test a model yourself?
          </h3>
          <p className="text-sm leading-relaxed text-fg/70">
            Enter any prompt to generate a 3D build in the Sandbox.
          </p>
        </div>
        <form
          className="relative flex w-full max-w-md items-center"
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
            className="mb-btn mb-btn-primary absolute right-1.5 top-1.5 bottom-1.5 flex items-center rounded-md px-4 text-sm"
            href={`/sandbox${customPrompt.trim() ? `?prompt=${encodeURIComponent(customPrompt.trim())}` : ""}`}
          >
            Generate
          </a>
        </form>
      </div>
    </div>
  );
}
