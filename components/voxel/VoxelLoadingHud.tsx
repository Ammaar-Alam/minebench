"use client";

export type VoxelLoadingProgress = {
  receivedBlocks: number;
  totalBlocks: number | null;
};

type VoxelLoadingHudProps = {
  label: string;
  progress?: VoxelLoadingProgress | null;
  elapsed?: string | null;
  attempt?: number;
  retryReason?: string;
  className?: string;
};

function clampPercent(progress?: VoxelLoadingProgress | null): number | null {
  const total = progress?.totalBlocks ?? null;
  const received = progress?.receivedBlocks ?? 0;
  if (!total || total <= 0) return null;
  return Math.max(1, Math.min(99, Math.round((received / total) * 100)));
}

export function formatVoxelLoadingMessage(
  base: string,
  progress?: VoxelLoadingProgress | null,
): string {
  const total = progress?.totalBlocks ?? null;
  const received = progress?.receivedBlocks ?? 0;
  if (!total || total <= 0) {
    if (received > 0) return `${base} ${received.toLocaleString()} blocks`;
    return `${base}...`;
  }
  const pct = clampPercent(progress);
  return `${base} ${pct ?? 0}%`;
}

export function VoxelLoadingHud({
  label,
  progress,
  elapsed,
  attempt,
  retryReason,
  className = "pointer-events-none absolute left-3 top-3 z-30",
}: VoxelLoadingHudProps) {
  const total = progress?.totalBlocks ?? null;
  const pct = clampPercent(progress);

  return (
    <div className={className}>
      <div className="flex w-[13.5rem] max-w-[70vw] flex-col gap-1.5 rounded-md bg-bg/[0.55] px-2.5 py-1.5 backdrop-blur-sm sm:px-3">
        <div className="flex items-baseline justify-between gap-3 text-[10px] font-medium leading-none text-muted/70">
          <span className="truncate text-fg/65">{label}</span>
          {pct != null ? (
            <span className="shrink-0 font-mono tabular-nums">{pct}%</span>
          ) : null}
        </div>

        <div className="h-px w-full overflow-hidden bg-border/50">
          {pct != null ? (
            <span
              className="block h-full bg-accent/70 transition-[width] duration-300 ease-out motion-reduce:transition-none"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <span className="mb-progress-wait block h-full w-full" />
          )}
        </div>

        {(total || elapsed || (attempt && attempt > 1) || retryReason) ? (
          <div className="flex items-baseline justify-between gap-3 font-mono text-[10px] leading-none tabular-nums text-muted/45">
            <span>{elapsed ?? ""}</span>
            <div className="flex items-center gap-2">
              {retryReason ? (
                <details className="group pointer-events-auto relative">
                  <summary
                    aria-label="Why MineBench is trying again"
                    className="flex h-5 w-5 cursor-pointer list-none items-center justify-center rounded text-muted transition-colors hover:bg-card hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 11v5" />
                      <path d="M12 8h.01" />
                    </svg>
                  </summary>
                  <div className="absolute right-0 top-6 z-40 max-h-48 w-60 overflow-y-auto overscroll-contain rounded-md border border-border/80 bg-card p-3 text-left font-mono text-[11px] leading-relaxed text-muted shadow-lg sm:w-72">
                    <p className="font-sans font-medium text-fg">Retry details</p>
                    <pre className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{retryReason}</pre>
                  </div>
                </details>
              ) : null}
              {total ? <span className="shrink-0">{total.toLocaleString()}</span> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
