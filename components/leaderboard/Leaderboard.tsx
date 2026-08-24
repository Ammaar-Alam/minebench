"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LeaderboardResponse } from "@/lib/arena/types";
import { summarizeArenaVotes } from "@/lib/arena/voteMath";
import { ErrorState } from "@/components/ErrorState";
import { getConsistencyBand } from "@/lib/arena/consistencyBands";
import { FetchError, fetchWithRetry } from "@/lib/fetchWithRetry";
import {
  LEADERBOARD_CACHE_KEY,
  LEADERBOARD_STALE_MAX_AGE_MS,
} from "@/lib/leaderboardOrder";
import { matchesLeaderboardModelQuery } from "@/lib/leaderboardSearch";
import { formatAge, readStale, writeStale } from "@/lib/staleCache";
import { resolveModelSlug } from "@/lib/ai/modelCatalog";
import {
  ModelBenchmarkDetails,
  ModelBenchmarkDetailsInline,
  ModelBenchmarkDetailsTrigger,
} from "@/components/leaderboard/ModelBenchmarkDetails";
import { LeaderboardSkeleton } from "@/components/leaderboard/LeaderboardSkeleton";

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

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <circle cx="8.5" cy="8.5" r="5.25" />
      <path d="m12.4 12.4 4.1 4.1" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
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

function ModelSearchEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <span className="text-sm font-medium text-muted">No matching models.</span>
      <button
        type="button"
        onClick={onClear}
        className="mb-btn mb-btn-ghost h-11 px-4 text-xs"
      >
        Clear
      </button>
    </div>
  );
}

export function Leaderboard({
  initialData = null,
}: {
  initialData?: LeaderboardResponse | null;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [data, setData] = useState<LeaderboardResponse | null>(initialData);
  const [dataAgeMs, setDataAgeMs] = useState<number | null>(null);
  const [isStale, setIsStale] = useState(initialData != null);
  const [slow, setSlow] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [navigatingModelKey, setNavigatingModelKey] = useState<string | null>(null);
  const [showDetailed, setShowDetailed] = useState(false);
  const [expandedMobileModelKey, setExpandedMobileModelKey] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const modelSearchInputRef = useRef<HTMLInputElement>(null);
  const initialDataCachedRef = useRef(false);
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
  const visibleModels = useMemo(
    () => data?.models.filter((model) => matchesLeaderboardModelQuery(model, modelQuery)) ?? [],
    [data, modelQuery],
  );
  const hasModelQuery = modelQuery.trim().length > 0;
  const modelSearchStatus =
    data && hasModelQuery
      ? `${visibleModels.length} ${visibleModels.length === 1 ? "model" : "models"} found.`
      : "";

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    // 1. hydrate from stale cache immediately so the first paint shows data —
    //    but only when the cache is still within our stated freshness window
    //    (LEADERBOARD_STALE_MAX_AGE_MS). Beyond that, hours-old rankings as
    //    the primary table would mislead users; we'd rather show the loader
    //    and fall through to error handling if the fetch can't recover.
    const cached = readStale<LeaderboardResponse>(LEADERBOARD_CACHE_KEY, LEADERBOARD_STALE_MAX_AGE_MS);
    if (!initialData && cached.value && cached.isFresh) {
      setData(cached.value);
      setDataAgeMs(cached.ageMs);
      setIsStale(true);
    }
    if (initialData && !initialDataCachedRef.current) {
      writeStale(LEADERBOARD_CACHE_KEY, initialData);
      initialDataCachedRef.current = true;
    }
    const hasFallbackData = initialData != null || Boolean(cached.value && cached.isFresh);

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
        if (hasFallbackData) {
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
  }, [initialData, reloadToken]);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    setError(null);
    setRefreshError(null);
    setReloadToken((n) => n + 1);
  }, []);

  const clearModelQuery = useCallback(() => {
    setModelQuery("");
    setExpandedMobileModelKey(null);
    modelSearchInputRef.current?.focus();
  }, []);

  const getModelPath = (modelKey: string) =>
    `/leaderboard/${encodeURIComponent(resolveModelSlug(modelKey))}`;
  const navigateToModel = (modelKey: string) => {
    if (navigatingModelKey === modelKey) return;
    setNavigatingModelKey(modelKey);
    router.push(getModelPath(modelKey));
  };
  const prefetchModel = (modelKey: string) => {
    router.prefetch(getModelPath(modelKey));
  };

  if (!hydrated || (!data && !error)) {
    return <LeaderboardSkeleton slow={slow} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 sm:gap-5">
      <div className="mb-panel shrink-0 px-5 py-5 ring-inset before:hidden">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center xl:grid-cols-[minmax(0,1fr)_auto_auto] xl:gap-x-6 xl:gap-y-0">
          {topModel ? (
            <div className="mb-leaderboard-champion mb-model-reveal-in opacity-0 order-1 inline-flex min-h-[72px] max-w-full min-w-0 self-start items-center gap-2 py-0 pl-0 pr-2 min-[340px]:min-h-20 min-[340px]:gap-3 min-[340px]:pr-3 sm:order-none sm:col-span-2 sm:gap-4 sm:pr-4 xl:col-span-1">
              <span
                aria-hidden="true"
                className="relative flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full bg-accent/10 ring-1 ring-accent/35 min-[340px]:h-20 min-[340px]:w-20"
              >
                <span className="relative -translate-y-px text-center font-mono text-2xl font-semibold leading-none text-accent tabular-nums sm:text-[1.75rem]">
                  1
                </span>
              </span>
              <div className="flex min-w-0 flex-col gap-1.5 py-1.5">
                <div className="flex min-w-0 items-baseline gap-x-2 gap-y-0.5">
                  <span className="truncate font-display text-lg font-semibold tracking-tight text-fg sm:text-xl">
                    {topModel.displayName}
                  </span>
                  {/* Mobile-only small rating; desktop gets the hero Elo to the right. */}
                  <span className="hidden font-mono text-sm font-medium text-muted min-[340px]:inline sm:hidden">
                    {Math.round(topModel.rankScore).toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted2">
                  {topRecord || topWinRate != null ? (
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      {topRecord ? (
                        <span className="hidden sm:inline">{topRecord}</span>
                      ) : null}
                      {topRecord && topWinRate != null ? (
                        <span
                          aria-hidden="true"
                          className="hidden text-muted/30 sm:inline"
                        >
                          ·
                        </span>
                      ) : null}
                      {topWinRate != null ? <span>{formatPercent(topWinRate)} wins</span> : null}
                    </span>
                  ) : null}
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
            <div aria-hidden="true" className="order-1 h-12 sm:order-none sm:col-span-2 xl:col-span-1" />
          )}
          <div className="order-3 flex w-full min-w-0 flex-wrap items-center gap-3 sm:order-none sm:w-auto sm:justify-self-start">
            {activeModelCount > 0 ? (
              <span className="mb-model-reveal-in inline-flex min-h-8 items-center gap-2 px-1 font-mono text-[11px] text-muted2">
                <span className="relative h-1.5 w-1.5 shrink-0" aria-hidden="true">
                  <span className="absolute inset-0 rounded-full bg-success" />
                  <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
                </span>
                <span className="text-fg">Live</span>
                <span className="text-muted/40">·</span>
                <span>{activeModelCount} models</span>
                <span className="hidden text-muted/40 sm:inline">·</span>
                <span className="hidden sm:inline">{renderedVotes.toLocaleString()} votes</span>
              </span>
            ) : null}
            {isStale && refreshError ? (
              <button
                type="button"
                onClick={handleRetry}
                disabled={retrying}
                aria-live="polite"
                className="mb-refresh-retry inline-flex h-11 items-center gap-1.5 rounded-md px-3 font-mono text-[11px] text-warn ring-1 ring-warn/30 transition hover:bg-warn/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
                <span>
                  {retrying ? "Refreshing…" : `Couldn't refresh${dataAgeMs != null ? ` · ${formatAge(dataAgeMs)}` : ""}`}
                </span>
              </button>
            ) : null}
          </div>
          <div className="order-2 flex w-full min-w-0 items-center gap-3 sm:order-none sm:w-auto sm:justify-self-end">
            <button
              type="button"
              onClick={() => setShowDetailed((v) => !v)}
              aria-label={showDetailed ? "Hide details" : "Show details"}
              aria-pressed={showDetailed}
              className={`mb-btn mb-details-toggle hidden h-11 bg-transparent px-3.5 text-[11px] ring-1 ring-inset sm:inline-flex ${
                showDetailed
                  ? "text-accent ring-accent/45"
                  : "text-muted ring-border/60 hover:text-fg hover:ring-border"
              }`}
            >
              Details
            </button>
            <div
              role="search"
              aria-label="Leaderboard models"
              className="relative h-11 w-full rounded-md bg-bg text-sm ring-1 ring-inset ring-border transition-colors focus-within:ring-2 focus-within:ring-accent/50 sm:w-56 md:w-64 xl:w-72"
            >
              <label htmlFor="leaderboard-model-search" className="sr-only">
                Search models
              </label>
              <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted2" />
              <input
                ref={modelSearchInputRef}
                id="leaderboard-model-search"
                type="search"
                value={modelQuery}
                onChange={(event) => {
                  setModelQuery(event.target.value);
                  setExpandedMobileModelKey(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && modelQuery) {
                    event.preventDefault();
                    clearModelQuery();
                  }
                }}
                placeholder="Find a model"
                autoComplete="off"
                spellCheck={false}
                aria-controls="leaderboard-models"
                aria-describedby="leaderboard-search-status"
                className="mb-leaderboard-search-input h-full w-full appearance-none bg-transparent pl-10 pr-11 text-sm text-fg outline-none placeholder:text-muted2"
              />
              {modelQuery ? (
                <button
                  type="button"
                  onClick={clearModelQuery}
                  aria-label="Clear model search"
                  className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-md text-muted2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <span id="leaderboard-search-status" role="status" aria-live="polite" className="sr-only">
              {modelSearchStatus}
            </span>
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
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
        <div className="pointer-events-none absolute inset-y-0 right-0 z-20 hidden w-8 bg-gradient-to-l from-bg/70 to-transparent sm:block md:hidden" />

        <div
          id="leaderboard-models"
          className="mb-leaderboard-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]"
        >
          <div className="relative z-[2] space-y-2.5 p-2.5 sm:hidden">
	            {visibleModels.map((m) => {
	              const voteSummary = summarizeArenaVotes(m);
	              const consistency = m.consistency ?? 0;
	              const coveragePercent = Math.round((m.promptCoverage ?? 0) * 100);
	              const moveBadge = movementBadge(m);
	              return (
	                <div
	                  key={m.key}
	                  className={`w-full rounded-md p-3 text-left ring-1 ring-border/70 transition ${
	                    navigatingModelKey === m.key
	                      ? "opacity-75"
	                      : "active:ring-accent/45 active:from-bg/72"
	                  }`}
	                  onMouseEnter={() => prefetchModel(m.key)}
	                  onClick={() => navigateToModel(m.key)}
	                >
	                  <div className="flex items-start justify-between gap-3">
	                    <div className="flex min-w-0 items-start gap-3">
		                      <div className="flex w-9 flex-col items-center gap-0.5 pt-0.5">
		                        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-bg/65 px-1.5 text-[11px] font-mono text-muted ring-1 ring-border/80">
		                          {m.rank}
	                        </span>
	                        <MovementMark badge={moveBadge} />
	                      </div>
	                      <div className="min-w-0">
	                        <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
	                          <button
	                            type="button"
	                            className="min-w-0 truncate text-left text-[1rem] font-semibold tracking-tight text-fg focus-visible:outline-none focus-visible:text-accent"
	                            aria-label={`Open ${m.displayName} profile`}
	                            onFocus={() => prefetchModel(m.key)}
	                            onClick={(event) => {
	                              event.stopPropagation();
	                              navigateToModel(m.key);
	                            }}
	                          >
	                            {m.displayName}
	                          </button>
	                          <ModelBenchmarkDetailsTrigger
	                            displayName={m.displayName}
	                            expanded={expandedMobileModelKey === m.key}
	                            controlsId={`mobile-model-details-${m.key}`}
	                            onToggle={() =>
	                              setExpandedMobileModelKey((current) =>
	                                current === m.key ? null : m.key,
	                              )
	                            }
	                          />
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
	                      <div className="font-mono text-[1.15rem] font-semibold text-fg flex items-baseline justify-end gap-1">
	                        <span>{Math.round(m.rankScore).toLocaleString()}</span>
	                        {m.ci95 != null ? (
	                          <span className="text-[11px] font-normal text-muted2">
	                            <span className="text-muted2/70 font-sans font-light">±</span>
	                            {m.ci95.toFixed(1)}
	                          </span>
	                        ) : null}
	                      </div>
	                    </div>
                  </div>

                  <ModelBenchmarkDetailsInline
                    id={`mobile-model-details-${m.key}`}
                    modelKey={m.key}
                    displayName={m.displayName}
                    open={expandedMobileModelKey === m.key}
                  />

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
	                </div>
	              );
	            })}
            {data && visibleModels.length === 0 ? (
              <ModelSearchEmptyState onClear={clearModelQuery} />
            ) : null}
          </div>

          <table
            aria-label="Model rankings"
            data-details={showDetailed ? "open" : "closed"}
            className="mb-leaderboard-table relative z-[2] hidden w-full table-fixed border-separate border-spacing-0 text-left text-sm [font-variant-numeric:tabular-nums] sm:table"
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
                  data-help="Global Bradley-Terry rating on a standard 400-point Elo scale with 95% confidence interval (±). Expanded detail shows the interval range."
                  aria-label="Rating. Global Bradley-Terry rating on a 400-point Elo scale with 95% confidence interval."
                  tabIndex={0}
                >
                  <span className="mb-col-help-label">Rating</span>
                </th>
                <th
                  scope="col"
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="Top percent is confidence. Gray SE is standard error: lower SE produces tighter confidence intervals."
                  aria-label="Confidence. Statistical confidence based on estimation uncertainty."
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
		              {visibleModels.map((m, resultIndex) => {
		                const voteSummary = summarizeArenaVotes(m);
		                const tier = m.rank === 1 ? "champion" : m.rank <= 3 ? "top" : "base";
	                const moveBadge = movementBadge(m);
	                return (
	                  <tr
	                    key={m.key}
	                    data-tier={tier}
	                    onMouseEnter={() => prefetchModel(m.key)}
	                    onClick={() => navigateToModel(m.key)}
                    className={`mb-leaderboard-row group mb-card-enter ${
                      navigatingModelKey === m.key ? "opacity-75" : ""
                    }`}
                    style={{ animationDelay: `${Math.min(resultIndex, 10) * 34}ms` }}
                  >
	                    <td className="mb-leaderboard-model-cell px-3 py-3 sm:px-3.5 sm:py-3.5">
	                      <div className="flex items-start gap-3">
		                        <div className="mt-0.5 flex w-9 flex-col items-center gap-0.5">
		                          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-bg/62 px-1.5 text-[11px] font-mono text-muted ring-1 ring-border/80">
		                            {m.rank}
	                          </span>
	                          <MovementMark badge={moveBadge} />
	                        </div>
	                        <div className="min-w-0">
	                          <div className="flex min-w-0 items-center gap-1.5">
	                            <button
	                              type="button"
	                              className="min-w-0 truncate text-left font-medium text-fg transition-colors duration-200 group-hover:text-accent focus-visible:outline-none focus-visible:text-accent"
	                              aria-label={`Open ${m.displayName} profile`}
	                              onFocus={() => prefetchModel(m.key)}
	                              onClick={(event) => {
	                                event.stopPropagation();
	                                navigateToModel(m.key);
	                              }}
	                            >
	                              {m.displayName}
	                            </button>
	                            <ModelBenchmarkDetails modelKey={m.key} displayName={m.displayName} />
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
                      <div className="mb-leaderboard-rating-stack font-mono">
                        <div className="mb-leaderboard-rating-primary font-semibold tracking-tight text-fg/95 flex items-baseline justify-center gap-1">
                          <span>{Math.round(m.rankScore).toLocaleString()}</span>
                          {m.ci95 != null ? (
                            <span className="text-[11px] font-normal text-muted2 tracking-normal">
                              <span className="text-muted2/70 font-sans font-light">±</span>
                              {m.ci95.toFixed(1)}
                            </span>
                          ) : null}
                        </div>
                        <div
                          className={`mb-leaderboard-rating-detail ${
                            showDetailed ? "mb-leaderboard-rating-detail-open" : "mb-leaderboard-rating-detail-closed"
                          }`}
                          aria-hidden={!showDetailed}
                        >
                          <span>
                            {m.ciLower != null && m.ciUpper != null
                              ? `[${m.ciLower.toLocaleString()}, ${m.ciUpper.toLocaleString()}]`
                              : `SE ${Math.round(m.ratingDeviation)}`}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="mb-leaderboard-cell px-3 py-3 text-center sm:px-4 sm:py-3.5">
                      <div className={`font-mono text-sm ${confidenceClass(m.confidence)}`}>
                        {m.confidence}%
                      </div>
                      <div className="text-[11px] text-muted2">SE {Math.round(m.ratingDeviation)}</div>
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
              {data && visibleModels.length === 0 ? (
                <tr>
                  <td colSpan={showDetailed ? 9 : 6}>
                    <ModelSearchEmptyState onClear={clearModelQuery} />
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
