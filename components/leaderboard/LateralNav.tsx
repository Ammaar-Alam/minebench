"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import {
  fetchLeaderboardOrder,
  readLeaderboardOrderFromCache,
} from "@/lib/leaderboardOrder";

// generic helpers ------------------------------------------------------------

type ArrowKeyNavArgs = {
  onPrev: () => void;
  onNext: () => void;
  enabled: boolean;
};

/** attach ← / → listeners to window. ignores key events originating from
    form fields so typing in an input doesn't hop the page. */
export function useArrowKeyNav({ onPrev, onNext, enabled }: ArrowKeyNavArgs) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onPrev();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onPrev, onNext, enabled]);
}

type SwipeNavArgs = {
  onPrev: () => void;
  onNext: () => void;
  enabled: boolean;
  /** css selector — pointerdowns originating inside a matching element are
      ignored (e.g. a three.js canvas owns its own horizontal drag). */
  ignoreSelector?: string;
  /** element whose pointer events we listen to. defaults to window. */
  targetRef?: RefObject<HTMLElement | null>;
};

/** hand-rolled touch swipe detector. horizontal swipe >= 60px, under 600ms,
    with a 1.5x horizontal-over-vertical ratio so vertical scrolling is not
    accidentally interpreted as navigation. */
export function useSwipeNav({
  onPrev,
  onNext,
  enabled,
  ignoreSelector,
  targetRef,
}: SwipeNavArgs) {
  useEffect(() => {
    if (!enabled) return;
    const target: EventTarget = targetRef?.current ?? window;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let active = false;

    const onDown = (event: Event) => {
      const ev = event as PointerEvent;
      if (ev.pointerType !== "touch") return;
      if (ignoreSelector && ev.target instanceof Element) {
        if (ev.target.closest(ignoreSelector)) return;
      }
      startX = ev.clientX;
      startY = ev.clientY;
      startTime = performance.now();
      active = true;
    };
    const onUp = (event: Event) => {
      if (!active) return;
      active = false;
      const ev = event as PointerEvent;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const dt = performance.now() - startTime;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx < 60 || absDx < absDy * 1.5 || dt > 600) return;
      if (dx > 0) onPrev();
      else onNext();
    };
    const onCancel = () => {
      active = false;
    };

    target.addEventListener("pointerdown", onDown, { passive: true });
    target.addEventListener("pointerup", onUp, { passive: true });
    target.addEventListener("pointercancel", onCancel, { passive: true });
    return () => {
      target.removeEventListener("pointerdown", onDown);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
    };
  }, [onPrev, onNext, enabled, ignoreSelector, targetRef]);
}

// leaderboard-neighbors hook -------------------------------------------------

type Neighbors =
  | { loading: true; total: 0; rank: null; prev: null; next: null }
  | {
      loading: false;
      total: number;
      rank: number | null;
      prev: string | null;
      next: string | null;
    };

export function useLeaderboardNeighbors(currentKey: string): Neighbors {
  const [order, setOrder] = useState<string[] | null>(null);

  useEffect(() => {
    const cached = readLeaderboardOrderFromCache();
    if (cached) {
      setOrder(cached);
      return;
    }
    const controller = new AbortController();
    fetchLeaderboardOrder(controller.signal)
      .then((keys) => {
        setOrder(keys);
      })
      .catch(() => {
        // swallow — nav stays hidden rather than showing a broken cluster
      });
    return () => controller.abort();
  }, []);

  return useMemo<Neighbors>(() => {
    if (!order) {
      return { loading: true, total: 0, rank: null, prev: null, next: null };
    }
    const idx = order.indexOf(currentKey);
    if (idx === -1) {
      return { loading: false, total: order.length, rank: null, prev: null, next: null };
    }
    return {
      loading: false,
      total: order.length,
      rank: idx + 1,
      prev: idx > 0 ? order[idx - 1] : null,
      next: idx < order.length - 1 ? order[idx + 1] : null,
    };
  }, [order, currentKey]);
}

// chevrons -------------------------------------------------------------------

function ChevronLeft({ className }: { className?: string }) {
  return (
    <svg
      className={className}
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
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

// arrow button ---------------------------------------------------------------

function ArrowButton({
  direction,
  onClick,
  disabled,
  label,
}: {
  direction: "prev" | "next";
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      aria-label={label}
      tabIndex={disabled ? -1 : 0}
      className={
        disabled
          ? "pointer-events-none inline-flex h-9 w-8 items-center justify-center rounded-sm text-muted/25"
          : "inline-flex h-9 w-8 items-center justify-center rounded-sm text-muted/70 transition-colors duration-150 hover:text-fg focus-visible:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      }
    >
      {direction === "prev" ? (
        <ChevronLeft className="h-4 w-4" />
      ) : (
        <ChevronRight className="h-4 w-4" />
      )}
    </button>
  );
}

// counter --------------------------------------------------------------------

function Counter({
  label,
  srLabel,
  glyphOnly,
  current,
  total,
  loading,
}: {
  /** visible prefix — e.g. "#" (glyph) or "Prompt" (word). empty string hides it. */
  label: string;
  /** spoken by screen readers in place of the visible label. keeps `#` silent. */
  srLabel?: string;
  /** true when `label` is a single glyph like `#`; skips uppercase/tracking so it
      doesn't pick up the eyebrow letter-spacing treatment. */
  glyphOnly?: boolean;
  current: number | null;
  total: number;
  loading: boolean;
}) {
  return (
    <span
      className="inline-flex items-baseline gap-1 font-mono text-[11px] tabular-nums text-muted2"
      aria-live="polite"
      aria-atomic="true"
    >
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
      {label ? (
        <span
          aria-hidden={srLabel ? "true" : undefined}
          className={
            glyphOnly
              ? "text-muted/45"
              : "uppercase tracking-[0.08em] text-muted/75"
          }
        >
          {label}
        </span>
      ) : null}
      {loading ? (
        <>
          <span className="text-muted/50">—</span>
          <span className="text-muted/40">/</span>
          <span className="text-muted/50">—</span>
        </>
      ) : (
        <>
          <span className="text-fg">{current ?? "—"}</span>
          <span className="text-muted/40">/</span>
          <span className="text-muted/70">{total}</span>
        </>
      )}
    </span>
  );
}

// hero cluster ---------------------------------------------------------------

export function ModelLateralNav({
  currentKey,
  modalOpen,
}: {
  currentKey: string;
  modalOpen: boolean;
}) {
  const router = useRouter();
  const neighbors = useLeaderboardNeighbors(currentKey);

  const goto = useCallback(
    (key: string | null) => {
      if (!key) return;
      router.push(`/leaderboard/${encodeURIComponent(key)}`);
    },
    [router],
  );

  const prevKey = neighbors.loading ? null : neighbors.prev;
  const nextKey = neighbors.loading ? null : neighbors.next;
  const onPrev = useCallback(() => goto(prevKey), [goto, prevKey]);
  const onNext = useCallback(() => goto(nextKey), [goto, nextKey]);

  // prefetch neighbors so the route transition is instant
  useEffect(() => {
    if (prevKey) router.prefetch(`/leaderboard/${encodeURIComponent(prevKey)}`);
    if (nextKey) router.prefetch(`/leaderboard/${encodeURIComponent(nextKey)}`);
  }, [prevKey, nextKey, router]);

  const shortcutsEnabled = !modalOpen && !neighbors.loading && neighbors.rank != null;

  useArrowKeyNav({ onPrev, onNext, enabled: shortcutsEnabled });
  useSwipeNav({
    onPrev,
    onNext,
    enabled: shortcutsEnabled,
    ignoreSelector: 'canvas, input, textarea, select, [role="dialog"]',
  });

  // nothing to navigate to — hide the cluster entirely
  if (!neighbors.loading && neighbors.total <= 1) return null;
  if (!neighbors.loading && neighbors.rank == null) return null;

  const disablePrev = neighbors.loading || !neighbors.prev;
  const disableNext = neighbors.loading || !neighbors.next;

  const prevLabel = disablePrev
    ? "Already at rank 1"
    : `Previous model, rank ${(neighbors.rank ?? 1) - 1}`;
  const nextLabel = disableNext
    ? "Already at last rank"
    : `Next model, rank ${(neighbors.rank ?? 0) + 1}`;

  return (
    <div className="inline-flex items-center gap-2">
      <ArrowButton direction="prev" onClick={onPrev} disabled={disablePrev} label={prevLabel} />
      <Counter
        label="#"
        srLabel="Rank"
        glyphOnly
        current={neighbors.loading ? null : neighbors.rank}
        total={neighbors.loading ? 0 : neighbors.total}
        loading={neighbors.loading}
      />
      <ArrowButton direction="next" onClick={onNext} disabled={disableNext} label={nextLabel} />
    </div>
  );
}

// modal prompt nav -----------------------------------------------------------

export function PromptLateralNav({
  index,
  total,
  onPrev,
  onNext,
  enabled,
  surfaceRef,
}: {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  enabled: boolean;
  surfaceRef?: RefObject<HTMLElement | null>;
}) {
  const disablePrev = index <= 0;
  const disableNext = index >= total - 1;

  const handlePrev = useCallback(() => {
    if (disablePrev) return;
    onPrev();
  }, [disablePrev, onPrev]);
  const handleNext = useCallback(() => {
    if (disableNext) return;
    onNext();
  }, [disableNext, onNext]);

  useArrowKeyNav({ onPrev: handlePrev, onNext: handleNext, enabled });
  useSwipeNav({
    onPrev: handlePrev,
    onNext: handleNext,
    enabled,
    targetRef: surfaceRef,
    // the build preview owns its own horizontal drag (three.js orbit)
    ignoreSelector: "canvas, [data-no-swipe]",
  });

  if (total <= 1) {
    return (
      <Counter label="Prompt" current={index + 1} total={total} loading={false} />
    );
  }

  const prevLabel = disablePrev
    ? "Already at first prompt"
    : `Previous prompt, ${index} of ${total}`;
  const nextLabel = disableNext
    ? "Already at last prompt"
    : `Next prompt, ${index + 2} of ${total}`;

  return (
    <div className="inline-flex items-center gap-2">
      <ArrowButton direction="prev" onClick={handlePrev} disabled={disablePrev} label={prevLabel} />
      <Counter label="Prompt" current={index + 1} total={total} loading={false} />
      <ArrowButton direction="next" onClick={handleNext} disabled={disableNext} label={nextLabel} />
    </div>
  );
}
