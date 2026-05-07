import { gzipSync } from "fflate";
import { getPalette } from "@/lib/blocks/palettes";
import {
  exportVoxelBuild,
  type VoxelBuildExportFormat,
  type VoxelBuildExportStats,
} from "@/lib/voxel/export";
import type { VoxelBuild } from "@/lib/voxel/types";

type WorkerRequest = {
  type: "export";
  requestId: string;
  format: VoxelBuildExportFormat;
  build: VoxelBuild;
  palette: "simple" | "advanced";
};

type WorkerResponse =
  | { type: "progress"; requestId: string; stage: string }
  | {
      type: "complete";
      requestId: string;
      extension: "glb" | "stl" | "schem";
      mimeType: string;
      stats: VoxelBuildExportStats;
      bytes: ArrayBuffer;
    }
  | { type: "error"; requestId: string; message: string };

const workerScope = self as typeof globalThis & {
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

function post(message: WorkerResponse, transfer?: Transferable[]) {
  workerScope.postMessage(message, transfer);
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== "export") return;

  try {
    post({ type: "progress", requestId: message.requestId, stage: "Preparing" });
    const palette = getPalette(message.palette);
    const artifact = exportVoxelBuild(message.build, palette, message.format);
    const bytes =
      message.format === "schem"
        ? gzipSync(artifact.bytes, { mtime: 0 })
        : artifact.bytes;

    const buffer = exactBuffer(bytes);
    post(
      {
        type: "complete",
        requestId: message.requestId,
        extension: artifact.extension,
        mimeType: artifact.mimeType,
        stats: artifact.stats,
        bytes: buffer,
      },
      [buffer],
    );
  } catch (error) {
    post({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Export failed",
    });
  }
};
