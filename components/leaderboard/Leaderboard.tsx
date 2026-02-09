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
    <div className="flex h-full min-h-0 flex-col gap-4 sm:gap-6">
      <div className="mb-panel shrink-0 p-4 sm:p-5">
        <div className="mb-panel-inner flex flex-col gap-2">
          <div className="mb-badge w-fit">
            <span className="mb-dot" />
            <span className="text-fg">Leaderboard</span>
          </div>
          <div className="font-display text-[2rem] font-semibold tracking-tight sm:text-2xl">
            Rankings
          </div>
        </div>
      </div>

      {error ? (
        <div className="mb-subpanel shrink-0 p-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl bg-card/60 shadow-soft ring-1 ring-border">
        <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-8 bg-gradient-to-l from-bg/70 to-transparent md:hidden" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-8 bg-gradient-to-t from-bg/55 to-transparent sm:hidden" />

        <div className="min-h-0 flex-1 overflow-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
          <table
            aria-label="Model rankings"
            className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm"
          >
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="sticky top-0 z-10 border-b border-border bg-bg/85 px-3 py-2.5 backdrop-blur sm:px-4 sm:py-3">
                  Model
                </th>
                <th className="sticky top-0 z-10 border-b border-border bg-bg/85 px-3 py-2.5 backdrop-blur sm:px-4 sm:py-3">
                  Rating
                </th>
                <th className="sticky top-0 z-10 border-b border-border bg-bg/85 px-3 py-2.5 backdrop-blur sm:px-4 sm:py-3">
                  W
                </th>
                <th className="sticky top-0 z-10 border-b border-border bg-bg/85 px-3 py-2.5 backdrop-blur sm:px-4 sm:py-3">
                  L
                </th>
                <th className="sticky top-0 z-10 border-b border-border bg-bg/85 px-3 py-2.5 backdrop-blur sm:px-4 sm:py-3">
                  D
                </th>
                <th className="sticky top-0 z-10 border-b border-border bg-bg/85 px-3 py-2.5 backdrop-blur sm:px-4 sm:py-3">
                  Both bad
                </th>
                <th className="sticky top-0 z-10 border-b border-border bg-bg/85 px-3 py-2.5 backdrop-blur sm:px-4 sm:py-3">
                  Shown
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data?.models.map((m) => (
                <tr key={m.key} className="hover:bg-bg/30">
                  <td className="px-3 py-2.5 sm:px-4 sm:py-3">
                    <div className="font-medium text-fg">{m.displayName}</div>
                    <div className="text-xs text-muted">{m.provider}</div>
                  </td>
                  <td className="px-3 py-2.5 font-mono sm:px-4 sm:py-3">{m.eloRating.toFixed(0)}</td>
                  <td className="px-3 py-2.5 font-mono sm:px-4 sm:py-3">{m.winCount}</td>
                  <td className="px-3 py-2.5 font-mono sm:px-4 sm:py-3">{m.lossCount}</td>
                  <td className="px-3 py-2.5 font-mono sm:px-4 sm:py-3">{m.drawCount}</td>
                  <td className="px-3 py-2.5 font-mono sm:px-4 sm:py-3">{m.bothBadCount}</td>
                  <td className="px-3 py-2.5 font-mono sm:px-4 sm:py-3">{m.shownCount}</td>
                </tr>
              ))}
              {!data ? (
                <tr>
                  <td className="px-3 py-6 text-muted sm:px-4" colSpan={7}>
                    Loading…
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
