"use client";

import Link from "next/link";
import { useEffect } from "react";
import { isVoxelViewerWebGLUnavailableError } from "@/lib/voxel/errors";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      console.error("[mb/route-error]", error);
    }
  }, [error]);

  const webglUnavailable = isVoxelViewerWebGLUnavailableError(error);
  const title = webglUnavailable ? "Enable graphics acceleration" : "We hit a snag loading this page";
  const message = webglUnavailable
    ? "MineBench uses WebGL to render model builds in 3D in your browser. Turn on graphics acceleration, then reload."
    : "The site may be under heavy load. Try again in a moment.";

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center px-4 py-10">
      <div className="mx-auto w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-soft">
        <div className="space-y-3">
          <h1 className="text-xl font-semibold leading-tight tracking-tight">{title}</h1>
          <p className="max-w-[32ch] text-sm leading-6 text-muted">{message}</p>
          {error.digest ? (
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted2">ref {error.digest}</p>
          ) : null}
          <div className="flex items-center gap-4 pt-2">
            <button type="button" onClick={reset} className="mb-btn mb-btn-primary min-h-11 px-4 text-sm">
              Try again
            </button>
            <Link
              href="/"
              className="inline-flex min-h-11 items-center text-sm font-medium text-muted underline-offset-4 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Back to arena
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
