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
import { VoteBar } from "@/components/arena/VoteBar";
import { AnimatedPrompt } from "@/components/arena/AnimatedPrompt";
import { ModelReveal } from "@/components/arena/ModelReveal";

type ArenaState =
  | { kind: "loading" }
  | { kind: "ready"; matchup: ArenaMatchup }
  | { kind: "error"; message: string };

const MATCHUP_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_MATCHUP_REQUEST_TIMEOUT_MS ?? "12000",
  10,
);
const MATCHUP_REQUEST_RETRIES = Number.parseInt(
  process.env.NEXT_PUBLIC_ARENA_MATCHUP_REQUEST_RETRIES ?? "1",
  10,
);

async function fetchMatchupOnce(promptId?: string, signal?: AbortSignal): Promise<ArenaMatchup> {
  const url = new URL("/api/arena/matchup", window.location.origin);
  if (promptId) url.searchParams.set("promptId", promptId);
  // Adaptive mode keeps small builds instant while deferring large payloads.
  url.searchParams.set("payload", "adaptive");
  const res = await fetch(url, { method: "GET", credentials: "include", signal });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ArenaMatchup;
}

async function fetchMatchup(promptId?: string): Promise<ArenaMatchup> {
  const maxAttempts = Math.max(1, MATCHUP_REQUEST_RETRIES + 1);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timed = makeTimeoutSignal(undefined, MATCHUP_REQUEST_TIMEOUT_MS);
    try {
      return await fetchMatchupOnce(promptId, timed.signal);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error("Matchup request timed out");
      } else {
        lastError = err;
      }
    } finally {
      timed.cleanup();
    }
  }

  throw (lastError instanceof Error ? lastError : new Error("Failed to load matchup"));
}

async function submitVote(matchupId: string, choice: VoteChoice) {
  const res = await fetch("/api/arena/vote", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchupId, choice }),
  });
  if (!res.ok) throw new Error(await res.text());
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
    if (!res.ok) throw new Error(await res.text());
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
  hydratedHints?: ArenaMatchup["a"]["buildLoadHints"],
): ArenaMatchup {
  const lane = matchup[side];
  const baseHints = hydratedHints ?? lane.buildLoadHints;
  const updatedLane = {
    ...lane,
    build,
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

function formatBuildLoadingMessage(
  fullLoading: boolean,
  progress: SideLoadProgress | null,
): string {
  const base = fullLoading ? "Retrieving full build" : "Retrieving build";
  const total = progress?.totalBlocks ?? null;
  const received = progress?.receivedBlocks ?? 0;
  if (!total || total <= 0) return `${base}…`;
  const pct = Math.max(1, Math.min(99, Math.round((received / total) * 100)));
  return `${base} ${pct}%`;
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

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
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
  const [submitting, setSubmitting] = useState(false);
  const [reveal, setReveal] = useState<RevealState>({ kind: "none" });
  const [sideLoadState, setSideLoadState] = useState<SideLoadState | null>(null);
  const [viewerReady, setViewerReady] = useState<{ matchupId: string; a: boolean; b: boolean } | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [carouselScrollLeft, setCarouselScrollLeft] = useState(0);
  const [carouselScrollMax, setCarouselScrollMax] = useState(0);
  const [carouselThumbRatio, setCarouselThumbRatio] = useState(0.25);
  const [, forceTick] = useState(0);
  const stateRef = useRef<ArenaState>({ kind: "loading" });
  const submittingRef = useRef(false);
  const transitioningStateRef = useRef(false);
  const cardsScrollRef = useRef<HTMLDivElement | null>(null);
  const carouselTrackRef = useRef<HTMLDivElement | null>(null);
  const carouselDragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null);
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
      const ratio = el.scrollWidth > 0 ? el.clientWidth / el.scrollWidth : 1;
      setCarouselScrollMax(max);
      setCarouselScrollLeft(Math.min(el.scrollLeft, max));
      setCarouselThumbRatio(Math.max(0.18, Math.min(0.8, ratio)));
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

  function sleepMs(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  const cacheHydratedBuild = useCallback((ref: ArenaBuildRef, entry: CachedHydratedBuild) => {
    const estimated = entry.buildLoadHints?.fullEstimatedBytes ?? null;
    if (
      typeof estimated === "number" &&
      Number.isFinite(estimated) &&
      estimated > CLIENT_BUILD_CACHE_MAX_EST_BYTES
    ) {
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
          ),
        };
      });
    };

    try {
      const fetchWithDelivery =
        lane.buildLoadHints?.deliveryClass === "snapshot"
          ? fetchBuildVariantSnapshot(ref, opts?.signal)
          : fetchBuildVariantStream(ref, {
              signal: opts?.signal,
              onProgress: applyProgressiveBuild,
            });
      const payload = await fetchWithDelivery;
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
    let cancelled = false;
    setState({ kind: "loading" });
    fetchMatchup(undefined)
      .then((m) => {
        if (cancelled) return;
        setState({ kind: "ready", matchup: applyCachedBuildsToMatchup(m) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load matchup",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [applyCachedBuildsToMatchup]);

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

  async function handleVote(choice: VoteChoice) {
    if (!matchup || submitting) return;
    if (isMatchupBuildLoading(matchup, sideLoadStateRef.current)) return;
    const viewer = viewerReadyRef.current;
    if (!viewer || viewer.matchupId !== matchup.id || !viewer.a || !viewer.b) return;
    setSubmitting(true);
    clearAutoAdvance();
    advanceNowRequestedAtRef.current = null;
    const startedAt = Date.now();
    const advanceAt = startedAt + REVEAL_MS_AFTER_VOTE;
    setReveal({ kind: "reveal", matchupId: matchup.id, action: choice, startedAt, advanceAt, next: null });
    try {
      const nextPromise = fetchMatchup(undefined).then(applyCachedBuildsToMatchup);
      await submitVote(matchup.id, choice);
      const next = await nextPromise;
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
        message: err instanceof Error ? err.message : "Vote failed",
      });
      setReveal({ kind: "none" });
      setSubmitting(false);
    } finally {
      // `submitting` stays true through the reveal so users can see the model names.
    }
  }

  async function handleSkip() {
    if (!matchup || submitting) return;
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
  const carouselThumbLeftRatio =
    carouselScrollMax > 0
      ? clamp01((carouselScrollLeft / carouselScrollMax) * (1 - carouselThumbRatio))
      : 0;

  return (
    <div className="flex flex-col gap-4 md:gap-5">
      <div className="mb-panel p-3 sm:p-4 md:p-3">
        <div className="mb-panel-inner flex flex-col gap-3 md:gap-2.5">
          {/* prompt */}
          <div className="mb-subpanel relative overflow-hidden px-3 py-2.5 sm:px-4 sm:py-3 md:py-2.5">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-0 bg-gradient-to-r from-accent/[0.08] via-transparent to-accent2/[0.08]"
            />
            <div className="relative z-10 flex items-center gap-2.5 sm:gap-3">
              <div className="mb-badge shrink-0">
                <span className="mb-dot" />
                <span className="text-fg">Prompt</span>
              </div>
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
                  <div className="mb-badge">
                    <span className="mb-dot" />
                    <span className="text-fg">Prompt</span>
                  </div>
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
            <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {state.message}
            </div>
          ) : null}

	          {/* builds grid */}
	          <div
	            ref={cardsScrollRef}
	            className={`mb-x-scroll -mx-1 flex w-[calc(100%+0.5rem)] snap-x snap-proximity gap-2.5 overflow-x-auto px-1 pb-2 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:mx-0 md:w-full md:grid md:snap-none md:grid-cols-2 md:gap-3 md:overflow-visible md:px-0 md:pb-0 ${transitioning ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0"}`}
	          >
            <div
              className={`mb-card-enter min-w-[91%] shrink-0 snap-center rounded-3xl transition-all duration-200 ease-out motion-reduce:transition-none md:min-w-0 md:shrink md:snap-none ${revealModels && revealAction === "A" ? "mb-reveal-highlight-a" : ""} ${revealModels && revealAction === "B" ? "mb-reveal-dim" : ""}`}
            >
              <VoxelViewerCard
                title="Build A"
                subtitle={
                  <ModelReveal
                    revealed={revealModels}
                    provider={matchup?.a.model.provider}
                    modelName={matchup?.a.model.displayName}
                  />
                }
                voxelBuild={matchup?.a.build ?? null}
                skipValidation={Boolean(matchup?.a.serverValidated)}
                onBuildReadyChange={(ready) => {
                  const id = matchup?.id;
                  if (!id) return;
                  setViewerReady((prev) => {
                    if (!prev || prev.matchupId !== id) return prev;
                    if (prev.a === ready) return prev;
                    return { ...prev, a: ready };
                  });
                }}
                isLoading={buildALoading}
                loadingMode={buildALoadingMode}
                loadingMessage={buildALoadingMessage}
                loadingProgress={laneProgressA ?? undefined}
                autoRotate
                viewerSize="arena"
                actions={null}
              />
            </div>
            <div
              className={`mb-card-enter mb-card-enter-delay min-w-[91%] shrink-0 snap-center rounded-3xl transition-all duration-200 ease-out motion-reduce:transition-none md:min-w-0 md:shrink md:snap-none ${revealModels && revealAction === "B" ? "mb-reveal-highlight-b" : ""} ${revealModels && revealAction === "A" ? "mb-reveal-dim" : ""}`}
            >
              <VoxelViewerCard
                title="Build B"
                subtitle={
                  <ModelReveal
                    revealed={revealModels}
                    provider={matchup?.b.model.provider}
                    modelName={matchup?.b.model.displayName}
                  />
                }
                voxelBuild={matchup?.b.build ?? null}
                skipValidation={Boolean(matchup?.b.serverValidated)}
                onBuildReadyChange={(ready) => {
                  const id = matchup?.id;
                  if (!id) return;
                  setViewerReady((prev) => {
                    if (!prev || prev.matchupId !== id) return prev;
                    if (prev.b === ready) return prev;
                    return { ...prev, b: ready };
                  });
                }}
                isLoading={buildBLoading}
                loadingMode={buildBLoadingMode}
                loadingMessage={buildBLoadingMessage}
                loadingProgress={laneProgressB ?? undefined}
                autoRotate
                viewerSize="arena"
                actions={null}
              />
            </div>
          </div>

          {carouselScrollMax > 0 ? (
            <div className="px-1 md:hidden">
              <div
                ref={carouselTrackRef}
                role="slider"
                aria-label="Scroll between Build A and Build B"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={carouselScrollMax > 0 ? Math.round((carouselScrollLeft / carouselScrollMax) * 100) : 0}
                tabIndex={0}
                className="mb-carousel-track"
                onPointerDown={(e) => {
                  const el = cardsScrollRef.current;
                  const track = carouselTrackRef.current;
                  if (!el || !track || carouselScrollMax <= 0) return;
                  const rect = track.getBoundingClientRect();
                  const thumbWidth = rect.width * carouselThumbRatio;
                  const travel = Math.max(1, rect.width - thumbWidth);
                  const pointerOffset = e.clientX - rect.left;
                  const initialThumbLeft = clamp01((pointerOffset - thumbWidth / 2) / travel);
                  el.scrollTo({ left: initialThumbLeft * carouselScrollMax, behavior: "auto" });
                  carouselDragRef.current = {
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startScrollLeft: el.scrollLeft,
                  };
                  track.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const drag = carouselDragRef.current;
                  const el = cardsScrollRef.current;
                  const track = carouselTrackRef.current;
                  if (!drag || drag.pointerId !== e.pointerId || !el || !track || carouselScrollMax <= 0) return;
                  const rect = track.getBoundingClientRect();
                  const thumbWidth = rect.width * carouselThumbRatio;
                  const travel = Math.max(1, rect.width - thumbWidth);
                  const delta = e.clientX - drag.startX;
                  const scrollDelta = (delta / travel) * carouselScrollMax;
                  el.scrollTo({
                    left: Math.max(0, Math.min(carouselScrollMax, drag.startScrollLeft + scrollDelta)),
                    behavior: "auto",
                  });
                }}
                onPointerUp={(e) => {
                  const track = carouselTrackRef.current;
                  if (carouselDragRef.current?.pointerId === e.pointerId) {
                    carouselDragRef.current = null;
                  }
                  if (track?.hasPointerCapture(e.pointerId)) {
                    track.releasePointerCapture(e.pointerId);
                  }
                }}
                onPointerCancel={(e) => {
                  const track = carouselTrackRef.current;
                  if (carouselDragRef.current?.pointerId === e.pointerId) {
                    carouselDragRef.current = null;
                  }
                  if (track?.hasPointerCapture(e.pointerId)) {
                    track.releasePointerCapture(e.pointerId);
                  }
                }}
                onKeyDown={(e) => {
                  const el = cardsScrollRef.current;
                  if (!el || carouselScrollMax <= 0) return;
                  if (e.key === "ArrowRight") {
                    e.preventDefault();
                    el.scrollTo({ left: Math.min(carouselScrollMax, el.scrollLeft + el.clientWidth * 0.3), behavior: "smooth" });
                  }
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    el.scrollTo({ left: Math.max(0, el.scrollLeft - el.clientWidth * 0.3), behavior: "smooth" });
                  }
                }}
              >
                <div
                  className="mb-carousel-thumb"
                  style={{
                    width: `${(carouselThumbRatio * 100).toFixed(2)}%`,
                    left: `${(carouselThumbLeftRatio * 100).toFixed(2)}%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          {/* action bar (vote buttons ↔ reveal status) */}
          <div className="relative h-[8.4rem] sm:h-[7.5rem]">
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

                        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-border/40">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-accent/80 to-accent2/80 transition-[width] duration-100 ease-linear motion-reduce:transition-none"
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
      </div>

      {/* explanatory section */}
      <div className="mb-panel mb-panel-solid overflow-hidden p-5 sm:p-7 md:p-10">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent ring-1 ring-accent/20 sm:mb-5">
            <span>Unofficial Benchmark</span>
          </div>
          <h2 className="mb-3 font-display text-2xl font-bold tracking-tight text-fg md:mb-4 md:text-3xl">
            Spatial Intelligence Test
          </h2>
          <p className="mb-8 max-w-2xl text-[15px] leading-relaxed text-fg/85 sm:mb-12 sm:text-base">
            MineBench is an AI benchmark and LLM benchmark for Minecraft-style voxel builds.
            Models must generate raw JSON coordinates for blocks with no images or 3D tools. We
            visualize their pure code output here.
          </p>

          <div className="grid w-full grid-cols-1 gap-3.5 text-left sm:gap-5 md:grid-cols-2 lg:grid-cols-3 lg:gap-6">
            <div className="flex h-full flex-col rounded-2xl border border-border/40 bg-bg/30 p-5 sm:p-6">
              <div className="mb-4 text-accent">
                <svg
                  className="h-6 w-6"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <path d="M3.3 7l8.7 5 8.7-5" />
                  <path d="M12 22v-9" />
                </svg>
              </div>
              <div className="mb-2 font-semibold text-fg">Pure Logic</div>
              <div className="text-sm leading-relaxed text-fg/75">
                Models blindly derive 3D coordinates using only math and spatial reasoning. They ARE
                allowed to execute code (python) to help create the JSON; specifically they are
                given a custom voxelBuilder tool which gives them access to primitive functions such
                as cube, sphere, and square.
              </div>
            </div>

            <div className="flex h-full flex-col rounded-2xl border border-border/40 bg-bg/30 p-5 sm:p-6">
              <div className="mb-4 text-accent">
                <svg
                  className="h-6 w-6"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 3v18h18" />
                  <path d="M18 17V9" />
                  <path d="M13 17V5" />
                  <path d="M8 17v-3" />
                </svg>
              </div>
              <div className="mb-2 font-semibold text-fg">Elo Rated</div>
              <div className="text-sm leading-relaxed text-fg/75">
                Builds are ranked via head-to-head voting, creating a live leaderboard of spatial
                skill.
              </div>
            </div>

            <div className="flex h-full flex-col rounded-2xl border border-border/40 bg-bg/30 p-5 sm:p-6">
              <div className="mb-4 text-accent">
                <svg
                  className="h-6 w-6"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s 9-1.34 9-3V5" />
                </svg>
              </div>
              <div className="mb-2 font-semibold text-fg">Recorded Data</div>
              <div className="text-sm leading-relaxed text-fg/75">
                Prompts, generations, and votes are stored to compute rankings and track
                performance.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* sandbox cta - moved to bottom & polished */}
      <div className="mb-panel mb-panel-solid flex flex-col items-center gap-4 p-5 text-center sm:p-6 md:p-7">
        <div className="flex flex-col items-center gap-1">
          <h3 className="font-semibold text-fg">Want to test a model yourself?</h3>
          <p className="text-sm text-fg/70">
            Enter any prompt to generate a 3D build in the Sandbox.
          </p>
        </div>
        <div className="relative flex w-full max-w-md items-center">
          <input
            className="mb-field h-12 w-full pr-24 text-base shadow-sm focus:ring-accent/20"
            placeholder="e.g. A giant rubber duck..."
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
          />
          <div className="absolute right-1.5 top-1.5 bottom-1.5">
            <a
              className="mb-btn mb-btn-primary h-full px-4 text-sm shadow-sm"
              href={`/sandbox${customPrompt.trim() ? `?prompt=${encodeURIComponent(customPrompt.trim())}` : ""}`}
            >
              Generate
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
