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
  autoRotate,
  isLoading,
  error,
  palette = "simple",
}: {
  title: string;
  subtitle?: string;
  voxelBuild: unknown | null;
  autoRotate?: boolean;
  isLoading?: boolean;
  error?: string;
  palette?: "simple" | "advanced";
}) {
  const build = useMemo(() => asVoxelBuild(voxelBuild), [voxelBuild]);
  const blockCount = build?.blocks.length ?? 0;

  return (
    <div className="relative overflow-hidden rounded-3xl bg-card/55 shadow-soft ring-1 ring-border">
      <div className="flex items-start justify-between gap-3 border-b border-border bg-bg/10 px-4 py-3">
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold tracking-tight text-fg">
            {title}
          </div>
          {subtitle ? (
            <div className="truncate text-xs text-muted">{subtitle}</div>
          ) : null}
        </div>
        <div className="shrink-0 text-xs text-muted">
          {build ? <span className="font-mono">{blockCount} blocks</span> : null}
        </div>
      </div>

      <div className="relative h-[360px] w-full">
        {build ? (
          <VoxelViewer voxelBuild={build} palette={palette} autoRotate={autoRotate} />
        ) : null}

        {build ? (
          <div className="pointer-events-none absolute bottom-3 left-3 hidden gap-2 sm:flex">
            <span className="mb-badge">
              Drag: orbit <span className="mb-kbd">Space</span>+drag: pan • Scroll: zoom
            </span>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/55 text-sm text-muted backdrop-blur-sm">
          Generating…
        </div>
      ) : null}

      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/70 px-4 text-center text-sm text-danger">
          {error}
        </div>
      ) : null}

      {!build && !isLoading && !error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/20 text-sm text-muted">
          No build yet
        </div>
      ) : null}
    </div>
  );
}
