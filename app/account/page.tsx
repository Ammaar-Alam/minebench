import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signOutAccount } from "@/app/(auth)/actions";
import { getPersonalRanking } from "@/lib/account/personalRanking";
import { getCurrentAccount } from "@/lib/auth/account";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your rankings",
  robots: { index: false, follow: false },
};

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const account = await getCurrentAccount();
  if (!account) redirect("/sign-in?next=/account");
  const [ranking, params] = await Promise.all([
    getPersonalRanking(account.id),
    searchParams,
  ]);
  const firstName = account.displayName?.split(/\s+/)[0] || null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 py-4 sm:py-8">
      <header className="flex flex-col gap-5 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-3">
          <p className="mb-eyebrow">Personal leaderboard</p>
          <h1 className="font-display text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
            {firstName ? `${firstName}'s rankings` : "Your rankings"}
          </h1>
          <p className="text-sm text-muted">Built from your Arena votes.</p>
        </div>
        <Link href="/" className="mb-btn mb-btn-primary h-11 self-start sm:self-auto">
          Keep voting
        </Link>
      </header>

      {params.notice === "password" ? (
        <p role="status" className="mb-feedback mb-feedback-status">
          Password updated.
        </p>
      ) : null}
      {params.notice === "created" ? (
        <p role="status" className="mb-feedback mb-feedback-status">
          Account created.
        </p>
      ) : null}

      <section aria-label="Voting summary" className="grid border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-border">
        {[
          ["Votes", formatCount(ranking.totalVotes)],
          ["Ranked votes", formatCount(ranking.ratedVotes)],
          ["Models", formatCount(ranking.modelsCompared)],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between border-b border-border py-4 last:border-b-0 sm:block sm:border-b-0 sm:px-6 sm:first:pl-0 sm:last:pr-0">
            <p className="text-sm text-muted">{label}</p>
            <p className="font-mono text-2xl font-semibold tabular-nums text-fg sm:mt-2 sm:text-3xl">{value}</p>
          </div>
        ))}
      </section>

      <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <section className="min-w-0 space-y-4" aria-labelledby="ranking-title">
          <div className="flex items-end justify-between gap-4">
            <div className="space-y-1">
              <h2 id="ranking-title" className="text-xl font-semibold tracking-tight text-fg">Your order</h2>
              <p className="text-sm text-muted">Ties count. Both bad does not.</p>
            </div>
            {ranking.ratedVotes > 0 && ranking.ratedVotes < 5 ? (
              <span className="mb-eyebrow text-warn">Early signal</span>
            ) : null}
          </div>

          {ranking.models.length > 0 ? (
            <div className="overflow-hidden rounded-md border border-border">
              <div className="hidden grid-cols-[3rem_minmax(0,1fr)_9rem_5rem] gap-3 border-b border-border bg-card/50 px-4 py-3 text-[11px] uppercase tracking-[0.14em] text-muted sm:grid">
                <span>Rank</span>
                <span>Model</span>
                <span>Record</span>
                <span className="text-right">Votes</span>
              </div>
              <ol className="divide-y divide-border">
                {ranking.models.map((model) => (
                  <li key={model.key}>
                    <Link
                      href={`/leaderboard/${encodeURIComponent(model.slug)}`}
                      className="group grid min-h-20 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45 sm:grid-cols-[3rem_minmax(0,1fr)_9rem_5rem]"
                    >
                      <span className="font-mono text-sm tabular-nums text-muted">{model.rank}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-fg group-hover:text-accent">{model.displayName}</span>
                        <span className="mt-1 block truncate text-xs text-muted">
                          {model.provider}
                          <span className="sm:hidden"> · {model.wins}–{model.losses}–{model.ties}</span>
                        </span>
                      </span>
                      <span className="hidden font-mono text-sm tabular-nums text-muted sm:block">
                        {model.wins}–{model.losses}–{model.ties}
                        {model.bothBad > 0 ? <span className="mt-1 block text-[10px]">{model.bothBad} both bad</span> : null}
                      </span>
                      <span className="font-mono text-sm tabular-nums text-fg sm:text-right">{model.votes}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="rounded-md border border-border px-6 py-14 text-center sm:py-20">
              <p className="text-lg font-medium text-fg">Your ranking starts in the Arena.</p>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted">Choose between builds to shape your order.</p>
              <Link href="/" className="mb-btn mb-btn-primary mt-6 h-11">Vote now</Link>
            </div>
          )}
        </section>

        <aside className="space-y-6 border-t border-border pt-7 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0" aria-labelledby="account-title">
          <div className="space-y-1">
            <p className="mb-eyebrow">Account</p>
            <h2 id="account-title" className="sr-only">Account details</h2>
          </div>
          <dl className="space-y-5 text-sm">
            <div className="space-y-1">
              <dt className="text-muted">Email</dt>
              <dd className="break-all text-fg">{account.email}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted">Joined</dt>
              <dd className="text-fg">{new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(account.createdAt)}</dd>
            </div>
          </dl>
          <div className="space-y-2 border-t border-border pt-5">
            <Link href="/reset-password" className="mb-btn mb-btn-ghost h-10 w-full">Change password</Link>
            <form action={signOutAccount}>
              <button type="submit" className="mb-btn h-10 w-full text-muted hover:text-fg">Sign out</button>
            </form>
          </div>
        </aside>
      </div>
    </div>
  );
}
