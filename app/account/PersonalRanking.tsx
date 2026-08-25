import Link from "next/link";
import { getPersonalRanking } from "@/lib/account/personalRanking";

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function PersonalRankingSkeleton() {
  return (
    <section aria-label="Loading your ranking" aria-busy="true" className="animate-pulse space-y-4 motion-reduce:animate-none">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="h-6 w-32 rounded-sm bg-border/50" />
          <div className="h-4 w-52 rounded-sm bg-border/35" />
        </div>
        <div className="h-4 w-40 rounded-sm bg-border/35" />
      </div>
      <div className="overflow-hidden rounded-md border border-border">
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
    </section>
  );
}

export async function PersonalRanking({ userId }: { userId: string }) {
  const ranking = await getPersonalRanking(userId);

  return (
    <section className="space-y-4" aria-labelledby="ranking-title">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 id="ranking-title" className="text-xl font-semibold tracking-tight text-fg">
              Your ranking
            </h2>
            {ranking.ratedVotes > 0 && ranking.ratedVotes < 5 ? (
              <span className="mb-eyebrow text-warn">Early signal</span>
            ) : null}
          </div>
          <p className="text-sm text-muted">Ties count. Both bad does not.</p>
        </div>
        <p className="font-mono text-xs tabular-nums text-muted">
          {formatCount(ranking.totalVotes)} votes
          <span aria-hidden="true"> · </span>
          {formatCount(ranking.ratedVotes)} ranked
          <span aria-hidden="true"> · </span>
          {formatCount(ranking.modelsCompared)} models
        </p>
      </div>

      {ranking.models.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="hidden grid-cols-[3rem_minmax(0,1fr)_10rem_6rem] gap-3 border-b border-border bg-card/30 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted sm:grid">
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
    </section>
  );
}
