"use client";

import { useEffect, useRef, useState } from "react";
import { ArenaMatchup, VoteChoice } from "@/lib/arena/types";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { VoteBar } from "@/components/arena/VoteBar";
import { AnimatedPrompt } from "@/components/arena/AnimatedPrompt";
import { ModelReveal } from "@/components/arena/ModelReveal";

type ArenaState =
  | { kind: "loading" }
  | { kind: "ready"; matchup: ArenaMatchup }
  | { kind: "error"; message: string };

async function fetchMatchup(promptId?: string): Promise<ArenaMatchup> {
  const url = new URL("/api/arena/matchup", window.location.origin);
  if (promptId) url.searchParams.set("promptId", promptId);
  const res = await fetch(url, { method: "GET", credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ArenaMatchup;
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

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function isInsideViewer(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("[data-mb-voxel-viewer='true']"));
}

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button,a,[role='button'],[role='link'],summary"));
}

export function Arena() {
  const [state, setState] = useState<ArenaState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const [reveal, setReveal] = useState<RevealState>({ kind: "none" });
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
  const autoAdvanceTimeoutRef = useRef<number | null>(null);
  const handleVoteRef = useRef<(choice: VoteChoice) => Promise<void>>(
    async () => undefined
  );
  const handleSkipRef = useRef<() => Promise<void>>(async () => undefined);
  const advanceToNextRef = useRef<(matchupId: string, next: ArenaMatchup) => Promise<void>>(
    async () => undefined
  );

  const matchup = state.kind === "ready" ? state.matchup : null;
  const revealModels = Boolean(matchup && reveal.kind === "reveal" && reveal.matchupId === matchup.id);
  const revealAction: RevealAction | null = reveal.kind === "reveal" ? reveal.action : null;

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
    setPromptDialogOpen(false);
  }, [matchup?.id]);

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

  useEffect(() => {
    if (reveal.kind !== "reveal") return;
    const id = window.setInterval(() => forceTick((t) => t + 1), 120);
    return () => window.clearInterval(id);
  }, [reveal.kind, revealModels]);

  useEffect(() => {
    return () => clearAutoAdvance();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchMatchup(undefined)
      .then((m) => {
        if (cancelled) return;
        setState({ kind: "ready", matchup: m });
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
  }, []);

  const revealMeta = (() => {
    if (!matchup || reveal.kind !== "reveal" || reveal.matchupId !== matchup.id) {
      return { visible: false, secondsLeft: 0, progress: 0, nextReady: false };
    }

    const totalMs = Math.max(1, reveal.advanceAt - reveal.startedAt);
    const remainingMs = Math.max(0, reveal.advanceAt - Date.now());
    const progress = Math.min(1, Math.max(0, 1 - remainingMs / totalMs));
    const secondsLeft = remainingMs / 1000;
    return { visible: true, secondsLeft, progress, nextReady: Boolean(reveal.next) };
  })();

  async function advanceToNext(matchupId: string, next: ArenaMatchup) {
    const current = revealRef.current;
    if (current.kind !== "reveal" || current.matchupId !== matchupId) return;
    if (transitionRef.current) return;

    transitionRef.current = true;
    setTransitioning(true);
    clearAutoAdvance();

    await sleepMs(TRANSITION_OUT_MS);

    const still = revealRef.current;
    if (still.kind !== "reveal" || still.matchupId !== matchupId) {
      transitionRef.current = false;
      setTransitioning(false);
      return;
    }

    setState({ kind: "ready", matchup: next });
    setReveal({ kind: "none" });
    setSubmitting(false);

    // Let the new matchup mount at 0 opacity, then fade back in.
    requestAnimationFrame(() => {
      transitionRef.current = false;
      setTransitioning(false);
    });
  }

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
    setSubmitting(true);
    clearAutoAdvance();
    const startedAt = Date.now();
    const advanceAt = startedAt + REVEAL_MS_AFTER_VOTE;
    setReveal({ kind: "reveal", matchupId: matchup.id, action: choice, startedAt, advanceAt, next: null });
    try {
      await submitVote(matchup.id, choice);
      const next = await fetchMatchup(undefined);
      setReveal((prev) =>
        prev.kind === "reveal" && prev.matchupId === matchup.id
          ? { ...prev, next }
          : prev
      );
      scheduleAutoAdvance(matchup.id, advanceAt, next);
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
      const startedAt = Date.now();
      const advanceAt = startedAt + REVEAL_MS_AFTER_SKIP;
      setReveal({ kind: "reveal", matchupId: matchup.id, action: "SKIP", startedAt, advanceAt, next: null });
      const next = await fetchMatchup(undefined);
      setReveal((prev) =>
        prev.kind === "reveal" && prev.matchupId === matchup.id
          ? { ...prev, next }
          : prev
      );
      scheduleAutoAdvance(matchup.id, advanceAt, next);
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
      if (isTypingTarget(e.target) || isInsideViewer(e.target) || isInteractiveTarget(e.target)) return;
      if (stateRef.current.kind !== "ready") return;

      const isSubmitting = submittingRef.current;
      const isTransitioning = transitioningStateRef.current || transitionRef.current;
      const currentMatchup = stateRef.current.matchup;

      const current = revealRef.current;
      const isRevealingCurrent =
        current.kind === "reveal" && current.matchupId === currentMatchup.id;

      if (e.code === "Digit1") {
        if (isSubmitting || isTransitioning || isRevealingCurrent) return;
        e.preventDefault();
        void handleVoteRef.current("A");
        return;
      }

      if (e.code === "Digit2") {
        if (isSubmitting || isTransitioning || isRevealingCurrent) return;
        e.preventDefault();
        void handleVoteRef.current("B");
        return;
      }

      if (e.code !== "Space") return;

      if (isRevealingCurrent) {
        e.preventDefault();
        if (!current.next || isTransitioning) return;
        void advanceToNextRef.current(current.matchupId, current.next);
        return;
      }

      if (isSubmitting || isTransitioning) return;
      e.preventDefault();
      void handleSkipRef.current();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const promptText = matchup?.prompt.text ?? "";
  const isLongPrompt = promptText.length > 120;
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
            key={matchup?.id ?? "loading"}
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
                autoRotate
                viewerSize="arena"
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
                autoRotate
                viewerSize="arena"
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
                                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
                                  Loading…
                                </span>
                              )}
                            </div>

                            <button
                              type="button"
                              className="mb-btn mb-btn-ghost h-9 px-4 text-xs"
                              disabled={!revealMeta.nextReady || transitioning}
                              onClick={() => {
                                if (reveal.kind !== "reveal" || reveal.matchupId !== matchup?.id) return;
                                if (!reveal.next) return;
                                void advanceToNext(reveal.matchupId, reveal.next);
                              }}
                            >
                              Next <span className="hidden md:inline"><span className="mb-kbd">Space</span></span>
                            </button>
                          </div>
                        </div>

                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/40">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-accent/80 to-accent2/80 transition-[width] duration-100 ease-linear motion-reduce:transition-none"
                            style={{ width: `${(revealMeta.progress * 100).toFixed(1)}%` }}
                          />
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
