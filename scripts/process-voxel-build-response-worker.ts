import { parentPort, workerData } from "node:worker_threads";
import {
  processVoxelBuildResponse,
  type VoxelBuildResponseOptions,
} from "@/lib/ai/processVoxelBuildResponse";

if (!parentPort) throw new Error("Voxel response processing requires a worker thread");
const { text, opts } = workerData as { text: string; opts: VoxelBuildResponseOptions };
const result = processVoxelBuildResponse(text, opts);
const packed = result.ok ? result.build.packed : undefined;
parentPort.postMessage(result, packed
  ? [packed.positions.buffer as ArrayBuffer, packed.typeIds.buffer as ArrayBuffer]
  : []);
