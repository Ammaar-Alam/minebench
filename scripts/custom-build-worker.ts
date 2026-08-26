import "dotenv/config";
import { runCustomBuildWorkerLoop } from "@/lib/custom-builds/worker";

runCustomBuildWorkerLoop().catch((error) => {
  console.error(error);
  process.exit(1);
});
