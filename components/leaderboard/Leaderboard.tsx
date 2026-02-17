"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { LeaderboardResponse } from "@/lib/arena/types";

function formatPercent(value: number | null, digits = 0): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(digits)}%`;
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

export function Leaderboard() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const activeModelCount = data?.models.length ?? 0;
  const topModel = data?.models[0] ?? null;
  const topDecisiveVotes = topModel
    ? topModel.winCount + topModel.lossCount + topModel.drawCount
    : 0;
  const topWinRate = topModel && topDecisiveVotes > 0 ? topModel.winCount / topDecisiveVotes : null;
  const topRecord = topModel
    ? `${topModel.winCount.toLocaleString()}-${topModel.lossCount.toLocaleString()}-${topModel.drawCount.toLocaleString()}`
    : null;
  const renderedVotes =
    data?.models.reduce(
      (sum, model) =>
        sum + model.winCount + model.lossCount + model.drawCount + model.bothBadCount,
      0
    ) ?? 0;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leaderboard", { method: "GET" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed"))))
      .then((d: LeaderboardResponse) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load leaderboard");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 sm:gap-5">
      <div className="mb-panel shrink-0 p-4 sm:p-[1.1rem]">
        <div className="mb-panel-inner flex flex-col gap-3.5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="mb-badge w-fit">
              <span className="mb-dot" />
              <span className="text-fg">Leaderboard</span>
            </div>
            <div className="font-display text-[2rem] font-semibold tracking-tight sm:text-[2.2rem]">
              Rankings
            </div>
            {topModel ? (
              <div className="mb-leaderboard-favorite mb-model-reveal mb-model-reveal-in">
                <div className="mb-leaderboard-favorite-head">
                  <span className="mb-leaderboard-favorite-kicker">Top model</span>
                  <span className="mb-leaderboard-favorite-name">{topModel.displayName}</span>
                </div>
                <div className="mb-leaderboard-favorite-meta">
                  <span className="mb-leaderboard-favorite-chip">{topRecord} record</span>
                  {topWinRate != null ? (
                    <span className="mb-leaderboard-favorite-chip">
                      {formatPercent(topWinRate)} wins
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          {activeModelCount > 0 ? (
            <div className="mb-leaderboard-live-chip mb-model-reveal mb-model-reveal-in group w-fit max-w-full">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted2">
                <span className="text-fg">Live</span>
                <span>{activeModelCount} models</span>
                <span>{renderedVotes.toLocaleString()} votes</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mb-subpanel shrink-0 p-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl bg-card/60 shadow-soft ring-1 ring-border">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-28 bg-gradient-to-b from-accent/10 via-accent2/6 to-transparent"
        />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-8 bg-gradient-to-l from-bg/70 to-transparent md:hidden" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-8 bg-gradient-to-t from-bg/55 to-transparent sm:hidden" />

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]">
          <table
            aria-label="Model rankings"
            className="relative z-[2] w-full table-fixed border-separate border-spacing-0 text-left text-sm [font-variant-numeric:tabular-nums]"
          >
            <colgroup>
              <col className="w-[32%] md:w-[23%]" />
              <col className="w-[14%] md:w-[11%]" />
              <col className="w-[22%] md:w-[18%]" />
              <col className="hidden md:table-column md:w-[10%]" />
              <col className="hidden md:table-column md:w-[10%]" />
              <col className="w-[18%] md:w-[17%]" />
              <col className="w-[14%] md:w-[11%]" />
            </colgroup>
            <thead className="text-xs uppercase text-muted2">
              <tr>
                <th className="mb-leaderboard-header mb-leaderboard-header-model text-left">
                  <span
                    className="mb-col-help-label"
                    title="Model name and provider."
                  >
                    Model
                  </span>
                </th>
                <th
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="Overall rank score from matchups. Beating stronger models raises this faster."
                  title="Overall rank score from matchups. Beating stronger models raises this faster."
                >
                  <span className="mb-col-help-label">Rating</span>
                </th>
                <th
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="How steady performance is across prompts. Higher means fewer swings."
                  title="How steady performance is across prompts. Higher means fewer swings."
                >
                  <span className="mb-col-help-label">Consistency</span>
                </th>
                <th
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help hidden text-center md:table-cell"
                  data-help="Prompt-to-prompt variability. Lower spread means more stable output."
                  title="Prompt-to-prompt variability. Lower spread means more stable output."
                >
                  <span className="mb-col-help-label">Spread</span>
                </th>
                <th
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help hidden text-center md:table-cell"
                  data-help="Average prompt score in decisive comparisons. Higher means stronger typical output."
                  title="Average prompt score in decisive comparisons. Higher means stronger typical output."
                >
                  <span className="mb-col-help-label">Avg score</span>
                </th>
                <th
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="Win-loss-draw totals from decisive votes."
                  title="Win-loss-draw totals from decisive votes."
                >
                  <span className="mb-col-help-label">Record</span>
                </th>
                <th
                  className="mb-leaderboard-header mb-leaderboard-col-label mb-col-help text-center"
                  data-help="Total comparisons seen, including both-bad votes."
                  title="Total comparisons seen, including both-bad votes."
                >
                  <span className="mb-col-help-label">Votes</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.models.map((m, index) => {
                const decisiveVotes = m.winCount + m.lossCount + m.drawCount;
                const totalVotes = decisiveVotes + m.bothBadCount;
                const tierClass = index === 0 ? "mb-tier-glow-top" : index < 3 ? "mb-tier-glow" : "";
                const tier = index === 0 ? "champion" : index < 3 ? "top" : "base";
                return (
                  <tr
                    key={m.key}
                    role="link"
                    tabIndex={0}
                    data-tier={tier}
                    aria-label={`Open ${m.displayName} profile`}
                    onClick={() => router.push(`/leaderboard/${encodeURIComponent(m.key)}`)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      router.push(`/leaderboard/${encodeURIComponent(m.key)}`);
                    }}
                    className={`mb-leaderboard-row group mb-card-enter ${tierClass}`}
                    style={{ animationDelay: `${Math.min(index, 10) * 34}ms` }}
                  >
                    <td className="mb-leaderboard-model-cell px-3 py-3 sm:px-3.5 sm:py-3.5">
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-bg/62 px-1.5 text-[11px] font-mono text-muted ring-1 ring-border/80">
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-fg transition-colors duration-200 group-hover:text-accent group-focus-visible:text-accent">
                            {m.displayName}
                          </div>
                          <div className="truncate text-xs tracking-wide text-muted2">{m.provider}</div>
                        </div>
                      </div>
                    </td>
                    <td className="mb-leaderboard-cell px-3 py-3 text-center font-mono font-semibold tracking-tight text-fg/95 sm:px-4 sm:py-3.5">
                      {Math.round(m.eloRating).toLocaleString()}
                    </td>
                    <td className="mb-leaderboard-cell px-3 py-3 text-center sm:px-4 sm:py-3.5">
                      <div className="flex w-full items-center justify-center gap-1.5">
                        <span className="w-8 font-mono text-xs text-fg/95">
                          {m.consistency != null ? `${m.consistency}` : "—"}
                        </span>
                        <div className="h-1.5 w-full max-w-[10rem] overflow-hidden rounded-full bg-border/40">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-500"
                            style={{
                              width: `${Math.max(
                                0,
                                Math.min(100, m.consistency ?? 0)
                              ).toFixed(1)}%`,
                            }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="mb-leaderboard-cell hidden px-3 py-3 text-center align-middle md:table-cell sm:px-4 sm:py-3.5">
                      <div className={`font-mono text-xs ${spreadTone(m.scoreSpread)}`}>
                        {formatPercent(m.scoreSpread)}
                      </div>
                      <div className="text-[11px] uppercase tracking-wide text-muted2">
                        {spreadLabel(m.scoreSpread)}
                      </div>
                    </td>
                    <td className="mb-leaderboard-cell hidden px-3 py-3 text-center align-middle md:table-cell sm:px-4 sm:py-3.5">
                      <div className="flex flex-col items-center gap-1 font-mono">
                        <span className="font-semibold text-fg/95">{formatPercent(m.meanScore)}</span>
                      </div>
                    </td>
                    <td className="mb-leaderboard-cell px-3 py-3 text-center align-middle sm:px-4 sm:py-3.5">
                      <div className="mb-leaderboard-record-grid font-mono text-[11px]">
                        <span className="mb-leaderboard-outcome-chip mb-leaderboard-outcome-chip-success">
                          W {m.winCount}
                        </span>
                        <span className="mb-leaderboard-outcome-chip mb-leaderboard-outcome-chip-danger">
                          L {m.lossCount}
                        </span>
                        <span className="mb-leaderboard-outcome-chip mb-leaderboard-outcome-chip-muted">
                          D {m.drawCount}
                        </span>
                      </div>
                    </td>
                    <td className="mb-leaderboard-cell px-3 py-3 text-center sm:px-4 sm:py-3.5">
                      <div className="space-y-1.5">
                        <div className="font-mono text-xs font-semibold text-fg">{totalVotes.toLocaleString()}</div>
                        <div className="mb-leaderboard-votes-meta text-xs tracking-tight text-muted2">
                          {m.bothBadCount.toLocaleString()} both bad
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!data ? (
                <tr role="status" aria-live="polite">
                  <td className="px-3 py-6 text-muted sm:px-4" colSpan={7}>
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
