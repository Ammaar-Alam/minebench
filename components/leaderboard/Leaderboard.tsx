"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { LeaderboardResponse } from "@/lib/arena/types";
import { summarizeArenaVotes } from "@/lib/arena/voteMath";
import { ErrorState } from "@/components/ErrorState";
import { getConsistencyBand } from "@/lib/arena/consistencyBands";
import { FetchError, fetchWithRetry } from "@/lib/fetchWithRetry";
import { formatAge, readStale, writeStale } from "@/lib/staleCache";

const LEADERBOARD_CACHE_KEY = "mb-leaderboard-v3";
// accept cached data up to 10 min — older than that we prefer "loading…" over shipping stale rankings
const LEADERBOARD_STALE_MAX_AGE_MS = 10 * 60 * 1000;
const LEADERBOARD_SLOW_THRESHOLD_MS = 5_000;
const LEADERBOARD_TIMEOUT_MS = 10_000;

function ChevronUp({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 10l4-4 4 4" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
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
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function formatPercent(value: number | null, digits = 0): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatMetricValue(value: number | null, digits = 1): string {
  if (value == null) return "—";
  const rounded = Number(value.toFixed(digits));
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(digits);
}

function spreadTone(spread: number | null): string {
  if (spread == null) return "text-muted";
  if (spread <= 0.12) return "text-success";
  if (spread <= 0.2) return "text-accent";
  return "text-warn";
}

function spreadLabel(spread: number | null): string {
  if (spread == null) return "Insufficient";
  if (spread <= 0.12) return "Stable";
  if (spread <= 0.2) return "Mixed";
  return "Swingy";
}

function stabilityChipClass(stability: "Provisional" | "Established" | "Stable"): string {
  if (stability === "Stable") return "bg-success/15 text-success ring-success/35";
  if (stability === "Established") return "bg-accent/15 text-accent ring-accent/35";
  return "bg-warn/14 text-warn ring-warn/35";
}

function stabilityDotClass(stability: string): string {
  if (stability === "Stable") return "bg-success";
  if (stability === "Established") return "bg-accent";
  return "bg-warn";
}

function confidenceClass(confidence: number): string {
  if (confidence >= 75) return "text-success";
  if (confidence >= 50) return "text-accent";
  return "text-warn";
}

function consistencyNumberClass(consistency: number | null): string {
  const band = getConsistencyBand(consistency);
  if (band === "very-steady") return "text-success";
  if (band === "steady") return "text-accent";
  if (band === "mixed") return "text-warn";
  if (band === "high-swing") return "text-danger";
  return "text-muted";
}

function consistencyFillClass(consistency: number | null): string {
  const band = getConsistencyBand(consistency);
  if (band === "very-steady") return "relative bg-success after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-white/30";
  if (band === "steady") return "relative bg-accent after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-white/26";
  if (band === "mixed") return "relative bg-warn after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-white/24";
  if (band === "high-swing") return "relative bg-danger after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-white/24";
  return "bg-muted/45";
}

type MovementBadge = {
  kind: "new" | "up" | "down";
  delta: number | null;
  toneClass: string;
  ariaLabel: string;
};

function movementBadge(model: LeaderboardResponse["models"][number]): MovementBadge | null {
  if (!model.movementVisible) return null;
  if (!model.hasBaseline24h) {
    return {
      kind: "new",
      delta: null,
      toneClass: "text-accent",
      ariaLabel: `${model.displayName} is new in the 24-hour movement window.`,
    };
  }

  const delta = model.rankDelta24h ?? 0;
  if (delta === 0) return null;
  if (delta > 0) {
    return {
      kind: "up",
      delta,
      toneClass: "text-success",
      ariaLabel: `${model.displayName} moved up ${delta} rank${delta === 1 ? "" : "s"} in 24 hours.`,
    };
  }
  const down = Math.abs(delta);
  return {
    kind: "down",
    delta: down,
    toneClass: "text-danger",
    ariaLabel: `${model.displayName} moved down ${down} rank${down === 1 ? "" : "s"} in 24 hours.`,
  };
}

function MovementMark({ badge }: { badge: MovementBadge | null }) {
  if (!badge) return null;
  const Icon = badge.kind === "up" ? ChevronUp : badge.kind === "down" ? ChevronDown : ChevronRight;
  const label = badge.kind === "new" ? "NEW" : String(badge.delta ?? "");
  return (
    <span
      className={`inline-flex items-center justify-center gap-0.5 whitespace-nowrap font-mono text-[10px] font-semibold leading-none ${badge.toneClass}`}
      aria-label={badge.ariaLabel}
    >
      <Icon className="h-3 w-3 opacity-90" />
      <span className={badge.kind === "new" ? "tracking-[0.12em]" : "tracking-tight"}>{label}</span>
    </span>
  );
}

export function Leaderboard() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [dataAgeMs, setDataAgeMs] = useState<number | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [slow, setSlow] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [navigatingModelKey, setNavigatingModelKey] = useState<string | null>(null);
  const [showDetailed, setShowDetailed] = useState(false);
  const router = useRouter();
  const activeModelCount = data?.models.length ?? 0;
  const topModel = data?.models[0] ?? null;
  const topVoteSummary = topModel ? summarizeArenaVotes(topModel) : null;
  const topWinRate =
    topModel && topVoteSummary && topVoteSummary.decisiveVotes > 0
      ? topModel.winCount / topVoteSummary.decisiveVotes
      : null;
  const topRecord = topModel
    ? `${topModel.winCount.toLocaleString()}-${(topVoteSummary?.decisiveLossCount ?? 0).toLocaleString()}-${topModel.drawCount.toLocaleString()}`
    : null;
  const renderedVotes =
    data?.models.reduce((sum, model) => sum + summarizeArenaVotes(model).totalVotes, 0) ?? 0;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    // 1. hydrate from stale cache immediately so the first paint shows data —
    //    but only when the cache is still within our stated freshness window
    //    (LEADERBOARD_STALE_MAX_AGE_MS). Beyond that, hours-old rankings as
    //    the primary table would mislead users; we'd rather show the loader
    //    and fall through to error handling if the fetch can't recover.
    const cached = readStale<LeaderboardResponse>(LEADERBOARD_CACHE_KEY, LEADERBOARD_STALE_MAX_AGE_MS);
    if (cached.value && cached.isFresh) {
      setData(cached.value);
      setDataAgeMs(cached.ageMs);
      setIsStale(true);
    }

    setError(null);
    setRefreshError(null);
    setSlow(false);

    // 2. fetch fresh — retries: 0 because the leaderboard is a heavy endpoint
    //    and auto-retries just compound DB pressure when the backend is already
    //    struggling. users get a manual "Try again" instead.
    fetchWithRetry("/api/leaderboard", {
      method: "GET",
      parentSignal: controller.signal,
      timeoutMs: LEADERBOARD_TIMEOUT_MS,
      retries: 0,
      slowThresholdMs: LEADERBOARD_SLOW_THRESHOLD_MS,
      onSlow: () => {
        if (!cancelled) setSlow(true);
      },
    })
      .then((r) => r.json())
      .then((d: LeaderboardResponse) => {
        if (cancelled) return;
        setData(d);
        setDataAgeMs(0);
        setIsStale(false);
        setRefreshError(null);
        writeStale(LEADERBOARD_CACHE_KEY, d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        const fetchErr = e instanceof FetchError
          ? e
          : new FetchError("network", "Failed to load leaderboard", null, true);
        // keep cached data on refresh failure only if it was fresh enough to
        // paint in the first place; otherwise fall through to the full error
        // state so we don't leave hours-old rankings on screen with a soft
        // "couldn't refresh" note pretending they're current.
        if (cached.value && cached.isFresh) {
          setRefreshError(fetchErr);
        } else {
          setError(fetchErr);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRetrying(false);
          setSlow(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadToken]);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    setError(null);
    setRefreshError(null);
    setReloadToken((n) => n + 1);
  }, []);

  const getModelPath = (modelKey: string) => `/leaderboard/${encodeURIComponent(modelKey)}`;
  const navigateToModel = (modelKey: string) => {
    if (navigatingModelKey === modelKey) return;
    setNavigatingModelKey(modelKey);
    router.push(getModelPath(modelKey));
  };
  const prefetchModel = (modelKey: string) => {
    router.prefetch(getModelPath(modelKey));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 sm:gap-5">
      <div className="mb-panel shrink-0 px-5 py-5 before:hidden sm:px-8 sm:py-5 lg:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          {topModel ? (
            <div className="mb-model-reveal mb-model-reveal-in flex min-w-0 items-center gap-4 sm:gap-5">
              <span
                aria-hidden="true"
                className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/10 ring-1 ring-accent/35 sm:h-12 sm:w-12"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_4px_hsl(var(--accent)/0.06),0_10px_24px_-10px_hsl(var(--accent)/0.45)]"
                />
                <span className="relative text-center font-mono text-sm font-semibold leading-none tracking-tight text-accent tabular-nums sm:text-base">
                  1
                </span>
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 items-baseline gap-x-3 gap-y-0.5">
                  <span className="truncate font-display text-lg font-semibold tracking-tight text-fg sm:text-xl">
                    {topModel.displayName}
                  </span>
                  {/* Mobile-only small rating; desktop gets the hero Elo to the right. */}
                  <span className="font-mono text-sm font-medium text-muted sm:hidden">
                    {Math.round(topModel.rankScore).toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted2">
                  {topRecord ? <span>{topRecord}</span> : null}
                  {topWinRate != null ? (
                    <>
                      <span aria-hidden="true" className="text-muted/30">·</span>
                      <span>{formatPercent(topWinRate)} wins</span>
                    </>
                  ) : null}
                  <span aria-hidden="true" className="text-muted/30">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`h-1 w-1 rounded-full ${stabilityDotClass(topModel.stability)}`}
                    />
                    <span className="capitalize">{topModel.stability}</span>
                  </span>
                </div>
              </div>
              {/* Hero Elo — packed tight against the champion info on desktop.
                 Real data, prominent. Hidden on mobile where the small inline
                 Elo above appears next to the name. */}
              <div
                aria-hidden="true"
                className="hidden shrink-0 flex-col items-end gap-0.5 border-l border-border/60 pl-5 pr-2 sm:flex sm:pr-3"
              >
                <span className="font-display text-2xl font-semibold tabular-nums tracking-tight text-fg lg:text-[1.75rem]">
                  {Math.round(topModel.rankScore).toLocaleString()}
                </span>
                <span className="mb-eyebrow">Rating</span>
              </div>
            </div>
          ) : (
            <div aria-hidden="true" className="h-12" />
          )}
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:shrink-0 sm:gap-3">
            {activeModelCount > 0 ? (
              <span className="mb-model-reveal mb-model-reveal-in inline-flex items-center gap-2 font-mono text-[11px] text-muted2">
                <span className="relative h-1.5 w-1.5 shrink-0" aria-hidden="true">
                  <span className="absolute inset-0 rounded-full bg-success" />
                  <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
                </span>
                <span className="text-fg">Live</span>
                <span className="text-muted/40">·</span>
                <span>{activeModelCount} models</span>
                <span className="text-muted/40">·</span>
                <span>{renderedVotes.toLocaleString()} votes</span>
              </span>
            ) : null}
            {isStale && refreshError ? (
              <button
                type="button"
                onClick={handleRetry}
                disabled={retrying}
                aria-live="polite"
                className="mb-refresh-retry inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] text-warn ring-1 ring-warn/30 transition hover:bg-warn/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
                <span>
                  {retrying ? "Refreshing…" : `Couldn't refresh${dataAgeMs != null ? ` · ${formatAge(dataAgeMs)}` : ""}`}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setShowDetailed((v) => !v)}
              aria-pressed={showDetailed}
              className={`mb-btn h-7 rounded-full px-2.5 text-[11px] ${showDetailed ? "mb-btn-primary" : "mb-btn-ghost"}`}
            >
              {showDetailed ? "Hide details" : "Show details"}
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <ErrorState
          error={error}
          onRetry={handleRetry}
          retrying={retrying}
          className="shrink-0"
        />
      ) : null}
      {!data && slow ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-subpanel shrink-0 flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-muted"
        >
          <span className="mb-progress-wait relative h-1.5 w-6 overflow-hidden rounded-full bg-border/40" aria-hidden="true" />
          <span>Taking longer than usual — MineBench may be under heavy load.</span>
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl bg-card/60 shadow-soft ring-1 ring-border">
        <div className="pointer-events-none absolute inset-y-0 right-0 z-20 hidden w-8 bg-gradient-to-l from-bg/70 to-transparent sm:block md:hidden" />

        <div className="mb-leaderboard-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]">
          <div className="relative z-[2] space-y-2.5 p-2.5 sm:hidden">
	            {data?.models.map((m, index) => {
	              const voteSummary = summarizeArenaVotes(m);
	              const consistency = m.consistency ?? 0;
	              const coveragePercent = Math.round((m.promptCoverage ?? 0) * 100);
	              const moveBadge = movementBadge(m);
	              return (
                <button
                  key={m.key}
                  type="button"
                  className={`w-full rounded-2xl bg-gradient-to-b from-bg/62 to-bg/44 p-3 text-left ring-1 ring-border/70 transition ${
                    navigatingModelKey === m.key
                      ? "opacity-75"
                      : "active:ring-accent/45 active:from-bg/72"
                  }`}
                  onMouseEnter={() => prefetchModel(m.key)}
                  onFocus={() => prefetchModel(m.key)}
                  onClick={() => navigateToModel(m.key)}
                  aria-label={`Open ${m.displayName} profile`}
                >
	                  <div className="flex items-start justify-between gap-3">
	                    <div className="flex min-w-0 items-start gap-3">
	                      <div className="flex w-9 flex-col items-center gap-0.5 pt-0.5">
	                        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-bg/65 px-1.5 text-[11px] font-mono text-muted ring-1 ring-border/80">
	                          {index + 1}
	                        </span>
	                        <MovementMark badge={moveBadge} />
	                      </div>
	                      <div className="min-w-0">
	                        <div className="mt-1.5 min-w-0 truncate text-[1rem] font-semibold tracking-tight text-fg">
	                          {m.displayName}
	                        </div>
	                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
	                          <span className="truncate text-xs tracking-wide text-muted2">{m.provider}</span>
	                          <span
	                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-mono ring-1 ${stabilityChipClass(
	                              m.stability,
	                            )}`}
	                          >
	                            {m.stability}
	                          </span>
	                        </div>
	                      </div>
	                    </div>
	                    <div className="text-right">
	                      <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted2">
	                        Rating
                      </div>
                      <div className="font-mono text-[1.15rem] font-semibold text-fg">
                        {Math.round(m.rankScore).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                    <span
                      className={`inline-flex h-6 items-center rounded-full px-2 ring-1 ${
                        m.confidence >= 75
                          ? "bg-success/14 text-success ring-success/30"
                          : m.confidence >= 50
                            ? "bg-accent/14 text-accent ring-accent/30"
                            : "bg-warn/14 text-warn ring-warn/30"
                      }`}
                    >
                      Confidence {m.confidence}%
                    </span>
                    <span className="inline-flex h-6 items-center rounded-full bg-bg/58 px-2 text-muted2 ring-1 ring-border/70">
                      Coverage {coveragePercent}%
                    </span>
                  </div>

	                  <div className="mt-2.5 flex items-center gap-2">
	                    <span
                        className={`w-10 shrink-0 text-right font-mono text-xs font-medium ${consistencyNumberClass(
                          m.consistency,
                        )}`}
                      >
	                      {formatMetricValue(m.consistency)}
	                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/40">
                      <div
                        className={`h-full rounded-full transition-[width] duration-500 ${consistencyFillClass(
                          m.consistency,
                        )}`}
                        style={{
                          width: `${Math.max(0, Math.min(100, consistency)).toFixed(1)}%`,
                        }}
                      />
                    </div>
                    <span className="shrink-0 text-[11px] uppercase tracking-[0.12em] text-muted2">
                      Consistency
                    </span>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                    <span className="mb-leaderboard-outcome-chip mb-leaderboard-outcome-chip-success h-6 min-w-[2.75rem] px-2">
                      W {m.winCount}
                    </span>
                    <span className="mb-leaderboard-outcome-chip mb-leaderboard-outcome-chip-danger h-6 min-w-[2.75rem] px-2">
                      L {voteSummary.decisiveLossCount}
                    </span>
                    <span className="mb-leaderboard-outcome-chip mb-leaderboard-outcome-chip-muted h-6 min-w-[2.75rem] px-2">
                      D {m.drawCount}
                    </span>
                  </div>

                  <div className="mt-2.5 flex items-center justify-between text-xs text-muted2">
                    <span>{voteSummary.totalVotes.toLocaleString()} votes</span>
                    <span>{m.bothBadCount.toLocaleString()} both bad</span>
                  </div>
                </button>
              );
            })}
            {!data ? (
              <div className="mx-auto w-fit animate-pulse rounded-full bg-border/22 px-4 py-1.5 font-mono text-xs text-muted">
                Loading…
              </div>
            ) : null}
          </div>

          <table
            aria-label="Model rankings"
            className="relative z-[2] hidden w-full table-fixed border-separate border-spacing-0 text-left text-sm [font-variant-numeric:tabular-nums] sm:table"
          >
            <colgroup>
              <col className={showDetailed ? "w-[21%]" : "w-[28%]"} />
              <col className={showDetailed ? "w-[12%]" : "w-[14%]"} />
              <col className={showDetailed ? "w-[10%]" : "w-[14%]"} />
              {showDetailed ? <col className="w-[8%]" /> : null}
              <col className={showDetailed ? "w-[13%]" : "w-[18%]"} />
              {showDetailed ? <col className="w-[7%]" /> : null}
              {showDetailed ? <col className="w-[7%]" /> : null}
              <col className={showDetailed ? "w-[12%]" : "w-[14%]"} />
              <col className={showDetailed ? "w-[10%]" : "w-[12%]"} />
            </colgroup>
            <thead className="text-xs uppercase text-muted2">
              <tr>
                <th
                  scope="col"
                  className="mb-leaderboard-header mb-leaderboard-header-model mb-col-help text-left"
                  data-help="Model label. If shown, the small marker indicates rank movement vs 24h ago."
                  data-help-align="left"
                  aria-label="Model. Marker indicates rank movement versus 24 hours ago."
                  tabIndex={0}
                >
                  <span className="mb-col-help-label">Model</span>
                </th>
                <th
                  scope="col"
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="Primary rank score used for ordering. Gray subtext shows raw rating before uncertainty adjustment."
                  aria-label="Rating. Confidence-adjusted rank score used for ordering."
                  tabIndex={0}
                >
                  <span className="mb-col-help-label">Rating</span>
                </th>
                <th
                  scope="col"
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="Top percent is confidence. Gray RD is rating deviation (uncertainty): lower RD means more reliable."
                  aria-label="Confidence. Higher confidence means lower uncertainty."
                  tabIndex={0}
                >
                  <span className="mb-col-help-label">Confidence</span>
                </th>
                {showDetailed ? (
                  <th
                    scope="col"
                    className="mb-leaderboard-header mb-leaderboard-col-label mb-leaderboard-detail-col mb-col-help text-center"
                    data-help="Top percent is prompt coverage. Gray x/y is covered prompts out of all arena-eligible prompts."
                    aria-label="Coverage. Share of arena-eligible prompts with enough decisive votes for this model."
                    tabIndex={0}
                  >
                    <span className="mb-col-help-label">Coverage</span>
                  </th>
                ) : null}
                <th
	                  scope="col"
		                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
		                  data-help="Number and bar summarize the shrunk gap between this model's strongest and weakest prompt-strength tails. Higher means it stays in the same quality band across prompts."
		                  aria-label="Consistency. Higher means the model stays in the same quality band across prompts after prompt-strength shrinkage."
		                  tabIndex={0}
		                >
                  <span className="mb-col-help-label">Consistency</span>
                </th>
                {showDetailed ? (
	                  <th
		                    scope="col"
		                    className="mb-leaderboard-header mb-leaderboard-col-label mb-leaderboard-detail-col mb-col-help text-center"
		                    data-help="Raw prompt-to-prompt score variability across covered prompts before prompt-strength adjustment. Lower spread means observed scores are more tightly clustered."
		                    aria-label="Spread. Raw prompt-to-prompt score variability across covered prompts before prompt-strength adjustment."
		                    tabIndex={0}
		                  >
                    <span className="mb-col-help-label">Spread</span>
                  </th>
                ) : null}
                {showDetailed ? (
	                  <th
		                    scope="col"
		                    className="mb-leaderboard-header mb-leaderboard-col-label mb-leaderboard-detail-col mb-col-help text-center"
		                    data-help="Unweighted mean of per-prompt observed scores across covered prompts. Higher means the model earned more head-to-head points on an average prompt."
		                    aria-label="Average score. Unweighted mean of per-prompt observed scores across covered prompts."
		                    tabIndex={0}
		                  >
                    <span className="mb-col-help-label">Avg score</span>
                  </th>
                ) : null}
                <th
                  scope="col"
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="Win-loss-draw totals from decisive votes. Both-bad votes are excluded."
                  aria-label="Record. Win-loss-draw totals from decisive votes."
                  tabIndex={0}
                >
                  <span className="mb-col-help-label">Record</span>
                </th>
                <th
                  scope="col"
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="Top number is total votes seen. Gray line shows both-bad count included in that total."
                  data-help-align="right"
                  aria-label="Votes. Total comparisons seen, including both-bad votes."
                  tabIndex={0}
                >
                  <span className="mb-col-help-label">Votes</span>
                </th>
              </tr>
            </thead>
            <tbody>
	              {data?.models.map((m, index) => {
	                const voteSummary = summarizeArenaVotes(m);
	                const tier = index === 0 ? "champion" : index < 3 ? "top" : "base";
	                const moveBadge = movementBadge(m);
	                return (
                  <tr
                    key={m.key}
                    role="link"
                    tabIndex={0}
                    data-tier={tier}
                    aria-label={`Open ${m.displayName} profile`}
                    onMouseEnter={() => prefetchModel(m.key)}
                    onFocus={() => prefetchModel(m.key)}
                    onClick={() => navigateToModel(m.key)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      navigateToModel(m.key);
                    }}
                    className={`mb-leaderboard-row group mb-card-enter cursor-pointer ${
                      navigatingModelKey === m.key ? "opacity-75" : ""
                    }`}
                    style={{ animationDelay: `${Math.min(index, 10) * 34}ms` }}
                  >
	                    <td className="mb-leaderboard-model-cell px-3 py-3 sm:px-3.5 sm:py-3.5">
	                      <div className="flex items-start gap-3">
	                        <div className="mt-0.5 flex w-9 flex-col items-center gap-0.5">
	                          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-bg/62 px-1.5 text-[11px] font-mono text-muted ring-1 ring-border/80">
	                            {index + 1}
	                          </span>
	                          <MovementMark badge={moveBadge} />
	                        </div>
	                        <div className="min-w-0">
	                          <div className="min-w-0 truncate font-medium text-fg transition-colors duration-200 group-hover:text-accent group-focus-visible:text-accent">
	                            {m.displayName}
	                          </div>
	                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
	                            <span className="truncate text-xs tracking-wide text-muted2">{m.provider}</span>
	                            <span
	                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-mono ring-1 ${stabilityChipClass(
	                                m.stability,
	                              )}`}
	                            >
	                              {m.stability}
	                            </span>
	                          </div>
	                        </div>
	                      </div>
	                    </td>
                    <td className="mb-leaderboard-cell px-3 py-3 text-center sm:px-4 sm:py-3.5">
                      <div className="font-mono font-semibold tracking-tight text-fg/95">
                        {Math.round(m.rankScore).toLocaleString()}
                      </div>
                    </td>
                    <td className="mb-leaderboard-cell px-3 py-3 text-center sm:px-4 sm:py-3.5">
                      <div className={`font-mono text-sm ${confidenceClass(m.confidence)}`}>
                        {m.confidence}%
                      </div>
                      <div className="text-[11px] text-muted2">RD {Math.round(m.ratingDeviation)}</div>
                    </td>
                    {showDetailed ? (
                      <td className="mb-leaderboard-cell mb-leaderboard-detail-col px-3 py-3 text-center sm:px-4 sm:py-3.5">
                        <div className="font-mono text-sm text-fg">
                          {Math.round((m.promptCoverage ?? 0) * 100)}%
                        </div>
                        <div className="text-[11px] text-muted2">
                          {m.coveredPrompts}/{m.activePrompts}
                        </div>
                      </td>
                    ) : null}
                    <td className="mb-leaderboard-cell px-3 py-3 text-center sm:px-4 sm:py-3.5">
	                      <div className="flex w-full items-center justify-center gap-1.5">
	                        <span
                            className={`w-10 font-mono text-xs font-medium ${consistencyNumberClass(
                              m.consistency,
                            )}`}
                          >
	                          {formatMetricValue(m.consistency)}
	                        </span>
                        <div className="h-1.5 w-full max-w-[8.5rem] overflow-hidden rounded-full bg-border/40">
                          <div
                            className={`h-full rounded-full transition-[width] duration-500 ${consistencyFillClass(
                              m.consistency,
                            )}`}
                            style={{
                              width: `${Math.max(0, Math.min(100, m.consistency ?? 0)).toFixed(1)}%`,
                            }}
                          />
                        </div>
                      </div>
                    </td>
                    {showDetailed ? (
                      <td className="mb-leaderboard-cell mb-leaderboard-detail-col px-3 py-3 text-center align-middle sm:px-4 sm:py-3.5">
                        <div className={`font-mono text-xs ${spreadTone(m.scoreSpread)}`}>
                          {formatPercent(m.scoreSpread)}
                        </div>
                        <div className="text-[11px] uppercase tracking-wide text-muted2">
                          {spreadLabel(m.scoreSpread)}
                        </div>
                      </td>
                    ) : null}
                    {showDetailed ? (
                      <td className="mb-leaderboard-cell mb-leaderboard-detail-col px-3 py-3 text-center align-middle sm:px-4 sm:py-3.5">
                        <div className="flex flex-col items-center gap-1 font-mono">
                          <span className="font-semibold text-fg/95">{formatPercent(m.meanScore)}</span>
                        </div>
                      </td>
                    ) : null}
                    <td className="mb-leaderboard-cell px-2.5 py-3 text-center align-middle sm:px-3 sm:py-3.5">
                      <div className="mb-leaderboard-record-grid font-mono text-[11px]">
                        <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-success">
                          W {m.winCount}
                        </span>
                        <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-danger">
                          L {voteSummary.decisiveLossCount}
                        </span>
                        <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-muted">
                          D {m.drawCount}
                        </span>
                      </div>
                    </td>
                    <td className="mb-leaderboard-cell px-2.5 py-3 text-center sm:px-3 sm:py-3.5">
                      <div className="mb-leaderboard-votes-stack">
                        <div className="mb-leaderboard-votes-total font-mono font-semibold text-fg">
                          {voteSummary.totalVotes.toLocaleString()}
                        </div>
                        <div className="mb-leaderboard-votes-meta text-muted2">
                          both bad {m.bothBadCount.toLocaleString()}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!data ? (
                <tr role="status" aria-live="polite">
                  <td className="px-3 py-6 text-muted sm:px-4" colSpan={showDetailed ? 9 : 6}>
                    <div className="mx-auto w-fit animate-pulse rounded-full bg-border/22 px-4 py-1.5 font-mono text-xs text-muted">
                      Loading…
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
