"use client";

import { useEffect, useRef, useState } from "react";
import { VoxelViewer, type VoxelViewerHandle } from "@/components/voxel/VoxelViewer";
import { readBuildVariantPayload } from "@/lib/arena/clientBuildResponse";
import type { RenderableVoxelBuild } from "@/lib/voxel/packedBlocks";

type RenderView = { rotationY: number; elevation?: number };

type RenderJob = {
  buildId: string;
  palette: "simple" | "advanced";
  views: RenderView[];
  size: number;
  background: string;
};

type PendingRender = RenderJob & {
  build: RenderableVoxelBuild;
  resolve: (images: string[]) => void;
  reject: (error: Error) => void;
};

declare global {
  interface Window {
    judgeRender?: (job: RenderJob) => Promise<string[]>;
  }
}

export function JudgeRenderHarness() {
  const viewerRef = useRef<VoxelViewerHandle | null>(null);
  const pendingRef = useRef<PendingRender | null>(null);
  const [pending, setPending] = useState<PendingRender | null>(null);

  useEffect(() => {
    window.judgeRender = async (job) => {
      // the script serves the same full-variant artifact the arena would
      const res = await fetch(`/__judge/build/${encodeURIComponent(job.buildId)}`);
      if (!res.ok) throw new Error(`Build fetch failed (${res.status})`);
      const { payload } = await readBuildVariantPayload(res, {
        fallbackIdentity: { buildId: job.buildId, variant: "full", checksum: null },
      });
      return new Promise<string[]>((resolve, reject) => {
        const next = { ...job, build: payload.voxelBuild, resolve, reject };
        pendingRef.current = next;
        setPending(next);
      });
    };
    return () => {
      delete window.judgeRender;
    };
  }, []);

  function finish(result: { images: string[] } | { error: Error }) {
    const job = pendingRef.current;
    if (!job) return;
    pendingRef.current = null;
    setPending(null);
    if ("error" in result) job.reject(result.error);
    else job.resolve(result.images);
  }

  function capture() {
    const job = pendingRef.current;
    const viewer = viewerRef.current;
    if (!job || !viewer) return;
    try {
      const images = job.views.map((view) => {
        const frame = viewer.captureFrame({ ...view, width: job.size, height: job.size });
        if (!frame) throw new Error("Viewer returned no frame");
        // captures are transparent so lay them over the viewer stage color
        const out = document.createElement("canvas");
        out.width = frame.width;
        out.height = frame.height;
        const ctx = out.getContext("2d");
        if (!ctx) throw new Error("No 2d context");
        ctx.fillStyle = job.background;
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(frame, 0, 0);
        return out.toDataURL("image/png");
      });
      finish({ images });
    } catch (error) {
      finish({ error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  return (
    <div style={{ position: "relative", width: pending?.size ?? 384, height: pending?.size ?? 384 }}>
      {pending ? (
        <VoxelViewer
          key={pending.buildId}
          ref={viewerRef}
          voxelBuild={pending.build}
          palette={pending.palette}
          autoRotate={false}
          showControls={false}
          onBuildReadyChange={(ready) => {
            if (ready) requestAnimationFrame(capture);
          }}
          onBuildErrorChange={(message) => {
            if (message) finish({ error: new Error(message) });
          }}
        />
      ) : null}
    </div>
  );
}
