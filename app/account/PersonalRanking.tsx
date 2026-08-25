import Link from "next/link";
import { getPersonalRanking } from "@/lib/account/personalRanking";

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function PersonalRankingSkeleton() {
  return (
    <div
      aria-label="Loading your ranking"
      aria-busy="true"
      className="animate-pulse overflow-hidden rounded-md border border-border motion-reduce:animate-none"
    >
      <div className="hidden h-11 border-b border-border bg-card/30 sm:block" />
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className="grid min-h-20 grid-cols-[2.5rem_minmax(0,1fr)_4rem] items-center gap-3 border-b border-border/65 px-4 py-3 last:border-b-0 sm:grid-cols-[3rem_minmax(0,1fr)_10rem_6rem]"
        >
          <div className="h-6 w-6 rounded-full bg-border/45" />
          <div className="space-y-2">
            <div className="h-4 w-36 max-w-full rounded-sm bg-border/50" />
            <div className="h-3 w-20 rounded-sm bg-border/35" />
          </div>
          <div className="hidden h-6 rounded-md bg-border/35 sm:block" />
          <div className="h-8 rounded-sm bg-border/35" />
        </div>
      ))}
    </div>
  );
}

export async function PersonalRanking({ userId }: { userId: string }) {
  const ranking = await getPersonalRanking(userId);

  return (
    <>
      {ranking.models.length > 0 ? (
        <div
          role="region"
          aria-label="Ranked models"
          tabIndex={0}
          className="max-h-[min(32rem,55dvh)] scroll-pt-11 overflow-x-hidden overflow-y-auto rounded-md border border-border [scrollbar-gutter:stable] [-webkit-overflow-scrolling:touch] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        >
          <div className="sticky top-0 z-10 hidden grid-cols-[3rem_minmax(0,1fr)_10rem_6rem] gap-3 border-b border-border bg-bg/95 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted backdrop-blur-sm sm:grid">
            <span>Rank</span>
            <span>Model</span>
            <span className="text-center">Record</span>
            <span className="text-center">Comparisons</span>
          </div>
          <ol>
            {ranking.models.map((model) => (
              <li key={model.key} className="last:[&>a]:border-b-0">
                <Link
                  href={`/leaderboard/${encodeURIComponent(model.slug)}`}
                  className="mb-leaderboard-row group grid min-h-20 grid-cols-[2.5rem_minmax(0,1fr)_4rem] items-center gap-3 px-4 py-3 sm:grid-cols-[3rem_minmax(0,1fr)_10rem_6rem]"
                >
                  <span className="inline-flex h-6 min-w-6 items-center justify-center justify-self-start rounded-full bg-bg/62 px-1.5 font-mono text-[11px] tabular-nums text-muted ring-1 ring-border/80">
                    {model.rank}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-fg transition-colors group-hover:text-accent">
                      {model.displayName}
                    </span>
                    <span className="mt-0.5 block truncate text-xs tracking-wide text-muted2">
                      {model.provider}
                    </span>
                    <span className="mt-2 grid max-w-52 grid-cols-3 gap-1 font-mono text-[10px] sm:hidden">
                      <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-success">
                        W {model.wins}
                      </span>
                      <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-danger">
                        L {model.losses}
                      </span>
                      <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-muted">
                        T {model.ties}
                      </span>
                    </span>
                  </span>
                  <span className="mb-leaderboard-record-grid hidden font-mono text-[11px] sm:inline-grid">
                    <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-success">
                      W {model.wins}
                    </span>
                    <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-danger">
                      L {model.losses}
                    </span>
                    <span className="mb-leaderboard-outcome-chip mb-leaderboard-record-chip mb-leaderboard-outcome-chip-muted">
                      T {model.ties}
                    </span>
                  </span>
                  <span className="mb-leaderboard-votes-stack">
                    <span className="mb-leaderboard-votes-total font-mono font-semibold tabular-nums text-fg">
                      {formatCount(model.votes)}
                    </span>
                    <span className="mb-leaderboard-votes-meta whitespace-nowrap text-muted2">
                      {formatCount(model.bothBad)} both bad
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="rounded-md border border-border px-6 py-12 text-center sm:py-16">
          <p className="text-lg font-medium text-fg">Your ranking starts in the Arena.</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            Vote on a few matchups to see which models you prefer.
          </p>
          <Link href="/" className="mb-btn mb-btn-primary mt-6 h-11">
            Start voting
          </Link>
        </div>
      )}
    </>
  );
}
