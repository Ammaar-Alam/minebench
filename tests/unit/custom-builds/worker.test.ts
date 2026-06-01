import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const previousLeaseSeconds = process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS;
const workerSource = readFileSync("lib/custom-builds/worker.ts", "utf8");
const exportJobSource = readFileSync("lib/custom-builds/exportJob.ts", "utf8");

(globalThis as unknown as { prisma?: unknown }).prisma = {};

async function main() {
  const { getCustomBuildSynchronousExportLeaseMs, getCustomBuildWorkerHeartbeatMs } = await import(
    "../../../lib/custom-builds/worker"
  );

  process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS = "30";
  assert.equal(
    getCustomBuildWorkerHeartbeatMs(),
    15_000,
    "minimum leases should renew before the expiry boundary",
  );

  process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS = "45";
  assert.equal(
    getCustomBuildWorkerHeartbeatMs(),
    22_500,
    "non-default leases should renew halfway through the lease",
  );

  process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS = "180";
  assert.equal(
    getCustomBuildWorkerHeartbeatMs(),
    30_000,
    "default long leases should keep the existing 30s heartbeat cap",
  );

  process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS = "30";
  assert.equal(
    getCustomBuildSynchronousExportLeaseMs(),
    30 * 60 * 1000,
    "synchronous exports should extend the lease beyond the shortest accepted lease window",
  );
  const runJobIndex = workerSource.indexOf("async function runJob");
  const extendIndex = workerSource.indexOf("extendCustomBuildJobLease(job.id, workerId, getCustomBuildSynchronousExportLeaseMs())");
  assert.ok(runJobIndex >= 0 && extendIndex > runJobIndex, "export jobs should extend the lease from the worker");
  const callbackIndex = exportJobSource.indexOf("await opts.beforeSynchronousExport?.()");
  const exportIndex = exportJobSource.indexOf("const artifact = exportVoxelBuild");
  assert.ok(
    callbackIndex >= 0 && exportIndex > callbackIndex,
    "export jobs should renew/extend the lease immediately before synchronous export work",
  );

  console.log("custom build worker lease checks passed");
}

main()
  .finally(() => {
    if (previousLeaseSeconds === undefined) {
      delete process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS;
    } else {
      process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS = previousLeaseSeconds;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
