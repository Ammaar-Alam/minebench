import { parentPort, workerData } from "node:worker_threads";
import {
  processVoxelBuildResponse,
  type VoxelBuildResponseOptions,
} from "@/lib/ai/processVoxelBuildResponse";

if (!parentPort) throw new Error("Voxel response processing requires a worker thread");
const { text, opts } = workerData as { text: string; opts: VoxelBuildResponseOptions };
const result = processVoxelBuildResponse(text, opts);
const transfer: ArrayBuffer[] = [];
if (result.ok) {
  const { packed, packedBoxes } = result.build;
  if (packed) transfer.push(packed.positions.buffer as ArrayBuffer, packed.typeIds.buffer as ArrayBuffer);
  for (const chunk of packedBoxes?.chunks ?? []) {
    transfer.push(chunk.coordinates.buffer as ArrayBuffer, chunk.typeIds.buffer as ArrayBuffer);
  }
}
parentPort.postMessage(result, transfer);
