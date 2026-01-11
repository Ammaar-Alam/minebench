"use client";

import { useMemo, ReactNode } from "react";
import { VoxelViewer } from "@/components/voxel/VoxelViewer";
import { getPalette } from "@/lib/blocks/palettes";
import type { VoxelBuild } from "@/lib/voxel/types";
import { validateVoxelBuild } from "@/lib/voxel/validate";

const VIEWER_MAX_BLOCKS_BY_GRID: Record<64 | 256 | 512, number> = {
  64: 262_144,
  256: 2_500_000,
  512: 10_000_000,
};

export function VoxelViewerCard({
  title,
  subtitle,
  voxelBuild,
  gridSize = 256,
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
  subtitle?: ReactNode;
  voxelBuild: unknown | null;
  gridSize?: 64 | 256 | 512;
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
  const rendered = useMemo(() => {
    if (!voxelBuild)
      return {
        build: null as VoxelBuild | null,
        warnings: [] as string[],
        error: null as string | null,
      };
    const paletteDefs = getPalette(palette);
    const maxBlocks = VIEWER_MAX_BLOCKS_BY_GRID[gridSize] ?? VIEWER_MAX_BLOCKS_BY_GRID[256];
    const validated = validateVoxelBuild(voxelBuild, {
      gridSize,
      palette: paletteDefs,
      maxBlocks,
    });
    if (!validated.ok) return { build: null, warnings: [], error: validated.error };
    return { build: validated.value.build, warnings: validated.value.warnings, error: null };
  }, [voxelBuild, gridSize, palette]);

  const build = rendered.build;
  const warnings = metrics?.warnings ?? rendered.warnings;
  const blockCount = metrics?.blockCount ?? build?.blocks.length ?? 0;
  const isThinking = Boolean(isLoading && attempt && attempt > 0 && !debugRawText);
  const combinedError = error ?? rendered.error ?? undefined;

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
            {subtitle ? <div className="min-h-[1.5rem] text-sm">{subtitle}</div> : null}
          </div>
          <div className="shrink-0 text-right text-xs text-muted">
            {build ? (
              <div className="flex flex-col items-end gap-0.5">
                <span className="font-mono">{blockCount} blocks</span>
                {timing ? <span className="font-mono">{timing}</span> : null}
                {warnings.length ? (
                  <span className="font-mono">
                    {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="relative h-[320px] w-full sm:h-[360px] md:h-[420px] lg:h-[520px]">
          {build ? (
            <VoxelViewer
              voxelBuild={build}
              palette={palette}
              autoRotate={autoRotate}
              animateIn={animateIn}
            />
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
              <div>{attempt === 0 ? "Connecting…" : isThinking ? "Thinking…" : "Streaming…"}</div>
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

        {combinedError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/70 px-4 text-center text-sm text-danger">
            <div className="flex w-full max-w-[92%] flex-col items-center gap-3">
              <div>{combinedError}</div>
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

        {!build && !isLoading && !combinedError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/20 text-sm text-muted">
            No build yet
          </div>
        ) : null}

        {warnings.length ? (
          <details className="border-t border-border bg-bg/10 px-4 py-3 text-xs text-muted">
            <summary className="cursor-pointer select-none font-semibold text-fg">
              Warnings ({warnings.length})
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {warnings.map((w, i) => (
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
