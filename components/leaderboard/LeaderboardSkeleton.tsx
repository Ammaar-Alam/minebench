import React from "react";

function SkeletonBlock({
  className,
  shimmer = false,
}: {
  className: string;
  shimmer?: boolean;
}) {
  return (
    <span
      className={`mb-leaderboard-skeleton-block${shimmer ? " mb-leaderboard-skeleton-shimmer" : ""} block ${className}`}
    />
  );
}

export function LeaderboardSkeleton({ slow = false }: { slow?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 sm:gap-5" aria-busy="true">
      <span role="status" aria-live="polite" className="sr-only">
        Loading leaderboard
      </span>

      <div
        className="mb-panel shrink-0 px-5 py-5 ring-inset before:hidden"
        aria-hidden="true"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center xl:grid-cols-[minmax(0,1fr)_auto_auto] xl:gap-x-6 xl:gap-y-0">
          <div className="order-1 inline-flex min-h-[72px] max-w-full min-w-0 items-center gap-3 pr-3 min-[340px]:min-h-20 sm:order-none sm:col-span-2 sm:gap-4 sm:pr-4 xl:col-span-1">
            <SkeletonBlock
              shimmer
              className="h-[72px] w-[72px] shrink-0 rounded-full min-[340px]:h-20 min-[340px]:w-20"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <SkeletonBlock
                shimmer
                className="h-5 w-36 max-w-full rounded-sm sm:w-44"
              />
              <SkeletonBlock className="h-2.5 w-28 rounded-sm" />
            </div>
            <div className="hidden shrink-0 flex-col items-end gap-2 border-l border-border/60 pl-5 pr-3 sm:flex">
              <SkeletonBlock className="h-7 w-16 rounded-sm" />
              <SkeletonBlock className="h-2 w-11 rounded-sm" />
            </div>
          </div>

          <div className="order-3 flex min-h-8 items-center px-1 sm:order-none">
            <SkeletonBlock className="h-2.5 w-32 rounded-sm" />
          </div>

          <div className="order-2 flex w-full min-w-0 items-center gap-3 sm:order-none sm:w-auto sm:justify-self-end">
            <SkeletonBlock className="hidden h-11 w-20 rounded-md sm:block" />
            <SkeletonBlock
              shimmer
              className="h-11 min-w-0 flex-1 rounded-md sm:w-64 sm:flex-none xl:w-72"
            />
          </div>
        </div>
      </div>

      {slow ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-subpanel shrink-0 flex items-center gap-2 rounded-md px-3 py-2 text-xs text-muted"
        >
          <span
            className="mb-progress-wait relative h-1.5 w-6 overflow-hidden rounded-full bg-border/40"
            aria-hidden="true"
          />
          <span>Taking longer than usual — MineBench may be under heavy load.</span>
        </div>
      ) : null}

      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border"
        aria-hidden="true"
      >
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="space-y-2.5 p-2.5 sm:hidden">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                className="mb-leaderboard-skeleton-row rounded-md p-3 ring-1 ring-border/70"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="flex w-9 shrink-0 justify-center pt-0.5">
                      <SkeletonBlock className="h-6 w-6 rounded-full" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <SkeletonBlock
                        shimmer={index % 3 === 0}
                        className="h-4 w-32 max-w-full rounded-sm"
                      />
                      <SkeletonBlock className="h-2.5 w-20 rounded-sm" />
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <SkeletonBlock className="h-2 w-10 rounded-sm" />
                    <SkeletonBlock className="h-5 w-14 rounded-sm" />
                  </div>
                </div>
                <div className="mt-2.5 flex gap-1.5">
                  <SkeletonBlock className="h-6 w-24 rounded-full" />
                  <SkeletonBlock className="h-6 w-20 rounded-full" />
                </div>
                <div className="mt-2.5 flex items-center gap-2">
                  <SkeletonBlock className="h-3 w-10 shrink-0 rounded-sm" />
                  <SkeletonBlock
                    shimmer={index % 3 === 1}
                    className="h-1.5 min-w-0 flex-1 rounded-full"
                  />
                  <SkeletonBlock className="h-2.5 w-16 shrink-0 rounded-sm" />
                </div>
                <div className="mt-2.5 flex gap-1.5">
                  <SkeletonBlock className="h-6 w-12 rounded-full" />
                  <SkeletonBlock className="h-6 w-12 rounded-full" />
                  <SkeletonBlock className="h-6 w-12 rounded-full" />
                </div>
                <div className="mt-2.5 flex items-center justify-between">
                  <SkeletonBlock className="h-2.5 w-16 rounded-sm" />
                  <SkeletonBlock className="h-2.5 w-20 rounded-sm" />
                </div>
              </div>
            ))}
          </div>

          <div className="hidden h-full min-h-0 sm:block">
            <div className="grid min-h-12 grid-cols-[28%_14%_14%_18%_14%_12%] items-center border-b border-border px-4">
              <SkeletonBlock className="h-2.5 w-16 rounded-sm" />
              <SkeletonBlock className="mx-auto h-2.5 w-12 rounded-sm" />
              <SkeletonBlock className="mx-auto h-2.5 w-16 rounded-sm" />
              <SkeletonBlock className="mx-auto h-2.5 w-20 rounded-sm" />
              <SkeletonBlock className="mx-auto h-2.5 w-14 rounded-sm" />
              <SkeletonBlock className="ml-auto h-2.5 w-10 rounded-sm" />
            </div>
            {Array.from({ length: 11 }, (_, index) => (
              <div
                key={index}
                className="mb-leaderboard-skeleton-row grid min-h-[66px] grid-cols-[28%_14%_14%_18%_14%_12%] items-center border-b border-border/65 px-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex w-9 shrink-0 justify-center">
                    <SkeletonBlock className="h-6 w-6 rounded-full" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <SkeletonBlock
                      shimmer={index % 3 === 0}
                      className="h-3.5 w-32 max-w-[80%] rounded-sm"
                    />
                    <SkeletonBlock className="h-2 w-20 rounded-sm" />
                  </div>
                </div>
                <SkeletonBlock className="mx-auto h-4 w-12 rounded-sm" />
                <div className="flex flex-col items-center gap-1.5">
                  <SkeletonBlock className="h-3.5 w-10 rounded-sm" />
                  <SkeletonBlock className="h-2 w-8 rounded-sm" />
                </div>
                <div className="flex items-center justify-center gap-2 px-3">
                  <SkeletonBlock className="h-3 w-8 rounded-sm" />
                  <SkeletonBlock
                    shimmer={index % 3 === 1}
                    className="h-1.5 w-20 max-w-[55%] rounded-full"
                  />
                </div>
                <div className="mx-auto flex gap-1">
                  <SkeletonBlock className="h-6 w-8 rounded-full" />
                  <SkeletonBlock className="h-6 w-8 rounded-full" />
                  <SkeletonBlock className="h-6 w-8 rounded-full" />
                </div>
                <div className="ml-auto flex flex-col items-end gap-1.5">
                  <SkeletonBlock className="h-3.5 w-12 rounded-sm" />
                  <SkeletonBlock className="h-2 w-14 rounded-sm" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
