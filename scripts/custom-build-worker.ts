import "dotenv/config";
import { runCustomBuildWorkerLoop } from "@/lib/custom-builds/worker";
import { processVoxelBuildResponseInWorker } from "./process-voxel-build-response";

runCustomBuildWorkerLoop(undefined, { processResponse: processVoxelBuildResponseInWorker }).catch((error) => {
  console.error(error);
  process.exit(1);
});
