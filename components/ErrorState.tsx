"use client";

import { describeFetchError } from "@/lib/fetchWithRetry";

type Props = {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /** tighter layout for inline banner use */
  compact?: boolean;
  /** override the auto-generated title */
  title?: string;
  /** override the auto-generated hint */
  hint?: string;
  className?: string;
};

export function ErrorState({ error, onRetry, retrying, compact, title, hint, className }: Props) {
  const described = describeFetchError(error);
  const resolvedTitle = title ?? described.title;
  const resolvedHint = hint ?? described.hint;

  return (
    <div
      role="alert"
      aria-live="polite"
      className={[
        "rounded-xl ring-1 ring-danger/30 bg-danger/10 text-fg",
        compact ? "px-3 py-2" : "px-3.5 py-3",
        className ?? "",
      ].join(" ").trim()}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-danger">{resolvedTitle}</div>
          {resolvedHint ? (
            <div className={`mt-0.5 text-fg/80 ${compact ? "text-xs" : "text-[13px]"}`}>
              {resolvedHint}
            </div>
          ) : null}
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="mb-btn mb-btn-ghost h-8 shrink-0 rounded-full px-3 text-xs disabled:cursor-not-allowed disabled:opacity-60"
          >
            {retrying ? "Retrying…" : "Try again"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
