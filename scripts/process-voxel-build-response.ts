import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  ProcessedVoxelBuildResponse,
  ProcessVoxelBuildResponse,
} from "@/lib/ai/processVoxelBuildResponse";

export const processVoxelBuildResponseInWorker: ProcessVoxelBuildResponse = async (text, opts, signal) => {
  signal?.throwIfAborted();
  const worker = new Worker(path.join(__dirname, "process-voxel-build-response-worker.cjs"), {
    workerData: {
      text,
      opts: {
        gridSize: opts.gridSize,
        palette: opts.palette,
        enableTools: opts.enableTools,
        minBlocks: opts.minBlocks,
        buildOutput: opts.buildOutput,
      },
    },
    // parent heap flags override this and it does not cap ArrayBuffers or process RSS
    resourceLimits: { maxOldGenerationSizeMb: 640 },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (result?: ProcessedVoxelBuildResponse, error?: unknown) => {
      if (settled) return;
      settled = true;
      try {
        await worker.terminate();
        signal?.throwIfAborted();
        if (error !== undefined) throw error;
        resolve(result!);
      } catch (cause) {
        reject(cause);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        worker.off("message", onMessage);
        worker.off("messageerror", onError);
        worker.off("error", onError);
        worker.off("exit", onExit);
      }
    };
    const onMessage = (result: ProcessedVoxelBuildResponse) => { void finish(result); };
    const onError = (error: Error & { code?: string }) => {
      void finish(undefined, error.code === "ERR_WORKER_OUT_OF_MEMORY"
        ? Object.assign(new Error("heap_limit_exceeded", { cause: error }), { code: error.code })
        : error);
    };
    const onExit = (code: number) => {
      void finish(undefined, new Error(`Voxel response worker exited without a result (${code})`));
    };
    const onAbort = () => { void finish(undefined, signal?.reason); };
    worker.once("message", onMessage);
    worker.once("messageerror", onError);
    worker.once("error", onError);
    worker.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
};
