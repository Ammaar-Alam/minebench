"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      console.error("[mb/route-error]", error);
    }
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="mb-panel w-full max-w-md p-5 text-center sm:p-6">
        <div className="mb-panel-inner space-y-3">
          <div className="mx-auto inline-flex items-center gap-2 rounded-full bg-danger/10 px-3 py-1 text-xs font-medium text-danger ring-1 ring-danger/30">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden="true" />
            <span>Something broke</span>
          </div>
          <h2 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
            We hit a snag loading this page
          </h2>
          <p className="text-sm text-muted">
            The site may be under heavy load. Your work isn&apos;t lost — try again in a moment.
          </p>
          {error.digest ? (
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted2">
              ref {error.digest}
            </p>
          ) : null}
          <div className="flex items-center justify-center gap-2 pt-1">
            <button type="button" onClick={reset} className="mb-btn mb-btn-primary h-9 px-4 text-sm">
              Try again
            </button>
            <Link href="/" className="mb-btn mb-btn-ghost h-9 px-4 text-sm">
              Back to arena
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
