import assert from "node:assert/strict";

const previousLeaseSeconds = process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS;

(globalThis as unknown as { prisma?: unknown }).prisma = {};

async function main() {
  const { getCustomBuildWorkerHeartbeatMs } = await import("../../../lib/custom-builds/worker");

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
