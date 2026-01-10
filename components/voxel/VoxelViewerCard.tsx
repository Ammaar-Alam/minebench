"use client";

import { useMemo } from "react";
import { VoxelViewer } from "@/components/voxel/VoxelViewer";
import type { VoxelBuild } from "@/lib/voxel/types";

function asVoxelBuild(value: unknown): VoxelBuild | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { version?: unknown; blocks?: unknown };
  if (v.version !== "1.0") return null;
  if (!Array.isArray(v.blocks)) return null;
  return value as VoxelBuild;
}

export function VoxelViewerCard({
  title,
  subtitle,
  voxelBuild,
  autoRotate = true,
  animateIn,
  isLoading,
  attempt,
  retryReason,
  elapsedMs,
  metrics,
  error,
  debugRawText,
  palette = "simple",
}: {
  title: string;
  subtitle?: string;
  voxelBuild: unknown | null;
  autoRotate?: boolean;
  animateIn?: boolean;
  isLoading?: boolean;
  attempt?: number;
  retryReason?: string;
  elapsedMs?: number;
  metrics?: { blockCount: number; warnings: string[]; generationTimeMs: number };
  error?: string;
  debugRawText?: string;
  palette?: "simple" | "advanced";
}) {
  const build = useMemo(() => asVoxelBuild(voxelBuild), [voxelBuild]);
  const blockCount = build?.blocks.length ?? 0;
  const isThinking = Boolean(isLoading && attempt && attempt > 0 && !debugRawText);

  const timing = useMemo(() => {
    const ms = metrics?.generationTimeMs;
    if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
    if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms)}ms`;
  }, [metrics?.generationTimeMs]);

  const elapsed = useMemo(() => {
    const ms = elapsedMs;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `${seconds}s`;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }, [elapsedMs]);

  return (
    <div className="mb-panel">
      <div className="mb-panel-inner">
        <div className="flex items-start justify-between gap-3 border-b border-border bg-bg/10 px-4 py-3">
          <div className="min-w-0">
            <div className="font-display text-base font-semibold tracking-tight text-fg">
              {title}
            </div>
            {subtitle ? (
              <div className="truncate text-sm font-medium text-muted">{subtitle}</div>
            ) : null}
          </div>
          <div className="shrink-0 text-right text-xs text-muted">
            {build ? (
              <div className="flex flex-col items-end gap-0.5">
                <span className="font-mono">{blockCount} blocks</span>
                {timing ? <span className="font-mono">{timing}</span> : null}
                {metrics?.warnings?.length ? (
                  <span className="font-mono">
                    {metrics.warnings.length} warning{metrics.warnings.length === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="relative h-[320px] w-full sm:h-[360px] md:h-[420px] lg:h-[520px]">
          {build ? (
            <VoxelViewer voxelBuild={build} palette={palette} autoRotate={autoRotate} animateIn={animateIn} />
          ) : null}

          {build ? (
            <div className="pointer-events-none absolute bottom-3 left-3 hidden gap-2 sm:flex">
              <span className="mb-badge">
                Drag to rotate • <span className="mb-kbd">Space</span>+drag to pan • Scroll to zoom
              </span>
            </div>
          ) : null}
        </div>

        {isLoading && !build ? (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/60 text-sm text-muted backdrop-blur-sm">
            <div className="flex max-w-[90%] flex-col items-center gap-1 text-center">
              <div>
                {attempt === 0 ? "Connecting…" : isThinking ? "Thinking…" : "Streaming…"}
              </div>
              {elapsed ? <div className="text-xs font-mono text-muted">{elapsed}</div> : null}
              {attempt && attempt > 1 ? (
                <div className="text-xs font-mono text-muted">retry {attempt}</div>
              ) : null}
              {retryReason ? <div className="text-xs text-muted">{retryReason}</div> : null}
              {debugRawText ? (
                <details className="mt-2 w-full rounded-md border border-border/70 bg-bg/30 p-2 text-left text-xs text-muted">
                  <summary className="cursor-pointer select-none font-semibold text-fg">
                    Live model output
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted">
{debugRawText}
                  </pre>
                </details>
              ) : null}
            </div>
          </div>
        ) : null}

        {isLoading && build ? (
          <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1 rounded-md border border-border/70 bg-bg/60 px-3 py-2 text-xs text-muted backdrop-blur-sm">
            <div className="pointer-events-none">
              {isThinking ? "Thinking…" : debugRawText ? "Streaming…" : "Generating…"}
            </div>
            <div className="font-mono">{blockCount.toLocaleString()} blocks</div>
            {elapsed ? <div className="font-mono">{elapsed}</div> : null}
            {attempt && attempt > 1 ? <div className="font-mono">retry {attempt}</div> : null}
          </div>
        ) : null}

        {error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/70 px-4 text-center text-sm text-danger">
            <div className="flex w-full max-w-[92%] flex-col items-center gap-3">
              <div>{error}</div>
              {debugRawText ? (
                <details className="w-full rounded-md border border-border/70 bg-bg/30 p-3 text-left text-xs text-muted">
                  <summary className="cursor-pointer select-none font-semibold text-fg">
                    Raw model output
                  </summary>
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted">
{debugRawText}
                  </pre>
                </details>
              ) : null}
            </div>
          </div>
        ) : null}

        {!build && !isLoading && !error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/20 text-sm text-muted">
            No build yet
          </div>
        ) : null}

        {metrics?.warnings?.length ? (
          <details className="border-t border-border bg-bg/10 px-4 py-3 text-xs text-muted">
            <summary className="cursor-pointer select-none font-semibold text-fg">
              Warnings ({metrics.warnings.length})
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {metrics.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {/* debugRawText shown in error overlay so it stays visible */}
      </div>
    </div>
  );
}
