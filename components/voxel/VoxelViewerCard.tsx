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

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-bg/30">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          {subtitle ? <div className="text-xs text-muted">{subtitle}</div> : null}
        </div>
        <div className="text-xs text-muted">
          {build ? <span className="font-mono">{build.blocks.length} blocks</span> : null}
        </div>
      </div>

      <div className="h-[340px] w-full">
        {build ? <VoxelViewer voxelBuild={build} palette={palette} autoRotate={autoRotate} /> : null}
      </div>

      {isLoading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/55 text-sm text-muted backdrop-blur-sm">
          Generating…
        </div>
      ) : null}

      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/70 px-4 text-center text-sm text-red-200">
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

