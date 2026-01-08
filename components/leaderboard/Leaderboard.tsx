"use client";

import { useEffect, useState } from "react";
import type { LeaderboardResponse } from "@/lib/arena/types";

export function Leaderboard() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="flex flex-col gap-6">
      <div className="mb-panel p-5">
        <div className="mb-panel-inner flex flex-col gap-2">
          <div className="mb-badge w-fit">
            <span className="mb-dot" />
            <span className="text-fg">Leaderboard</span>
            <span className="hidden text-muted2 sm:inline">curated prompts only</span>
          </div>
          <div className="font-display text-2xl font-semibold tracking-tight">
            Global Elo
          </div>
          <div className="text-sm text-muted">
            K=16. “Both bad” penalizes via Baseline.
          </div>
        </div>
      </div>

      {error ? (
        <div className="mb-subpanel p-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-3xl bg-card/60 shadow-soft ring-1 ring-border">
        <table className="min-w-[760px] w-full text-left text-sm">
          <thead className="border-b border-border bg-bg/25 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Model</th>
              <th className="px-4 py-3">Rating</th>
              <th className="px-4 py-3">W</th>
              <th className="px-4 py-3">L</th>
              <th className="px-4 py-3">D</th>
              <th className="px-4 py-3">Both bad</th>
              <th className="px-4 py-3">Shown</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data?.models.map((m) => (
              <tr key={m.key} className="hover:bg-bg/30">
                <td className="px-4 py-3">
                  <div className="font-medium text-fg">{m.displayName}</div>
                  <div className="text-xs text-muted">{m.provider}</div>
                </td>
                <td className="px-4 py-3 font-mono">{m.eloRating.toFixed(0)}</td>
                <td className="px-4 py-3 font-mono">{m.winCount}</td>
                <td className="px-4 py-3 font-mono">{m.lossCount}</td>
                <td className="px-4 py-3 font-mono">{m.drawCount}</td>
                <td className="px-4 py-3 font-mono">{m.bothBadCount}</td>
                <td className="px-4 py-3 font-mono">{m.shownCount}</td>
              </tr>
            ))}
            {!data ? (
              <tr>
                <td className="px-4 py-6 text-muted" colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
