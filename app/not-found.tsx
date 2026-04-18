import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="mb-panel w-full max-w-md p-5 text-center sm:p-6">
        <div className="mb-panel-inner space-y-3">
          <div className="mx-auto inline-flex items-center gap-2 rounded-full bg-bg/60 px-3 py-1 text-xs font-medium text-muted ring-1 ring-border/70">
            <span className="h-1.5 w-1.5 rounded-full bg-muted" aria-hidden="true" />
            <span>Not found</span>
          </div>
          <h2 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
            We couldn&apos;t find that page
          </h2>
          <p className="text-sm text-muted">
            It may have moved, or the link may be mistyped.
          </p>
          <div className="flex items-center justify-center gap-2 pt-1">
            <Link href="/" className="mb-btn mb-btn-primary h-9 px-4 text-sm">
              Go to arena
            </Link>
            <Link href="/leaderboard" className="mb-btn mb-btn-ghost h-9 px-4 text-sm">
              Leaderboard
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
