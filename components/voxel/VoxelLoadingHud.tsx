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
  const received = progress?.receivedBlocks ?? 0;
  const total = progress?.totalBlocks ?? null;
  const pct = clampPercent(progress);

  return (
    <div className={className}>
      <div className="flex max-w-[92vw] flex-col gap-2 rounded-xl border border-border/70 bg-bg/55 px-3 py-2 text-xs text-muted shadow-soft backdrop-blur-sm sm:max-w-xs">
        <div className="flex items-center gap-2 text-fg/90">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          <span className="font-medium">{label}</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/35">
            {pct != null ? (
              <span
                className="block h-full rounded-full bg-gradient-to-r from-accent/75 via-accent2/75 to-accent/75"
                style={{ width: `${pct}%` }}
              />
            ) : (
              <span className="mb-progress-wait block h-full w-full" />
            )}
          </div>

          {(received > 0 || total) ? (
            <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-muted/90">
              <span>{received > 0 ? received.toLocaleString() : ""}</span>
              <span>{total ? total.toLocaleString() : ""}</span>
            </div>
          ) : null}
        </div>

        {(elapsed || (attempt && attempt > 1)) ? (
          <div className="flex items-center gap-3 font-mono text-[11px] text-muted/80">
            {elapsed ? <span>{elapsed}</span> : null}
            {attempt && attempt > 1 ? <span>retry {attempt}</span> : null}
          </div>
        ) : null}

        {retryReason ? <div className="text-[11px] text-muted/75">{retryReason}</div> : null}
      </div>
    </div>
  );
}
