import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const previousLeaseSeconds = process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS;
const previousWorkerId = process.env.CUSTOM_BUILD_WORKER_ID;
const previousWorkerConcurrency = process.env.CUSTOM_BUILD_WORKER_CONCURRENCY;
delete process.env.CUSTOM_BUILD_WORKER_ID;
delete process.env.CUSTOM_BUILD_WORKER_CONCURRENCY;
const workerSource = readFileSync("lib/custom-builds/worker.ts", "utf8");
const exportJobSource = readFileSync("lib/custom-builds/exportJob.ts", "utf8");

(globalThis as unknown as { prisma?: unknown }).prisma = {};

async function main() {
  const {
    createCustomBuildProcessingGate,
    getCustomBuildSynchronousExportLeaseMs,
    getCustomBuildWorkerConcurrency,
    getCustomBuildWorkerHeartbeatMs,
    getCustomBuildWorkerId,
    isTerminalCustomBuildJobFailure,
  } = await import("../../../lib/custom-builds/worker");

  assert.equal(
    isTerminalCustomBuildJobFailure("generation_failed"),
    true,
    "a terminally failed build must not leave its job runnable",
  );

  assert.equal(
    getCustomBuildWorkerConcurrency(),
    10,
    "one worker process should overlap ten provider-bound jobs by default",
  );
  process.env.CUSTOM_BUILD_WORKER_CONCURRENCY = "4";
  assert.equal(getCustomBuildWorkerConcurrency(), 4);
  process.env.CUSTOM_BUILD_WORKER_CONCURRENCY = "100";
  assert.equal(getCustomBuildWorkerConcurrency(), 20, "configured concurrency should stay bounded");
  delete process.env.CUSTOM_BUILD_WORKER_CONCURRENCY;

  const processingGate = createCustomBuildProcessingGate();
  const releaseFirst = await processingGate.acquire();
  let secondAcquired = false;
  const second = processingGate.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false, "local build processing should remain single-file");
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  releaseSecond();

  const defaultWorkerId = getCustomBuildWorkerId();
  assert.match(
    defaultWorkerId,
    /^custom-worker-.+-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "default worker IDs should be globally unique across hosts and processes",
  );
  assert.equal(getCustomBuildWorkerId(), defaultWorkerId, "default worker ID should stay stable in-process");
  process.env.CUSTOM_BUILD_WORKER_ID = "configured-worker";
  assert.equal(getCustomBuildWorkerId(), "configured-worker");
  delete process.env.CUSTOM_BUILD_WORKER_ID;

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
  const extendIndex = workerSource.indexOf("extendCustomBuildJobLease(");
  assert.ok(runJobIndex >= 0 && extendIndex >= 0, "worker should be able to extend job leases");
  assert.ok(
    workerSource.includes("async function extendLeaseForSynchronousWork") &&
      workerSource.includes("await extendLeaseForSynchronousWork(job, workerId);"),
    "generate and export jobs should extend the lease through the shared synchronous-work helper",
  );
  assert.ok(
    workerSource.includes("randomUUID") && workerSource.includes("hostname()"),
    "worker fallback IDs should include host and random process identity",
  );
  const generatePackagingCallbackIndex = workerSource.indexOf("beforeSynchronousArtifactPackaging");
  assert.ok(
    generatePackagingCallbackIndex > runJobIndex &&
      workerSource.indexOf("await extendLeaseForSynchronousWork(job, workerId);", generatePackagingCallbackIndex) >
        generatePackagingCallbackIndex,
    "generate jobs should extend the lease before synchronous artifact packaging",
  );
  const heartbeatIndex = workerSource.indexOf("function startCustomBuildJobHeartbeat");
  const renewIndex = workerSource.indexOf("renewCustomBuildJobLease(job.id, workerId)", heartbeatIndex);
  const falseIndex = workerSource.indexOf("if (!renewed)", renewIndex);
  const catchIndex = workerSource.indexOf(".catch((error) =>", renewIndex);
  const abortIndex = workerSource.indexOf("abortLease(", renewIndex);
  assert.ok(
    heartbeatIndex >= 0 &&
      renewIndex > heartbeatIndex &&
      falseIndex > renewIndex &&
      catchIndex > renewIndex &&
      abortIndex > renewIndex,
    "heartbeat renewals should abort the active job on false results and caught failures",
  );
  assert.ok(
    workerSource.includes("runCustomBuildGenerateJob(job, {") && workerSource.includes("signal,"),
    "generate jobs should receive the heartbeat abort signal",
  );
  assert.ok(
    workerSource.includes("runCustomBuildExportJob(job, {") &&
      workerSource.indexOf("signal,", workerSource.indexOf("runCustomBuildExportJob(job, {")) > 0,
    "export jobs should receive the heartbeat abort signal",
  );
  assert.ok(
    workerSource.includes("isCustomBuildLeaseLostError(error)") &&
      workerSource.includes("return { processed: true, jobId: job.id, jobType: job.type };"),
    "lost leases should stop the worker path without failing a job it may no longer own",
  );
  assert.ok(
    workerSource.includes("const queueHeartbeat = setInterval") &&
      workerSource.includes("clearInterval(queueHeartbeat)"),
    "queue health reporting should continue while the worker drains active jobs",
  );
  const callbackIndex = exportJobSource.indexOf("await opts.beforeSynchronousExport?.()");
  const downloadIndex = exportJobSource.indexOf("const bytes = await downloadCustomBuildArtifactBytes");
  assert.ok(
    callbackIndex >= 0 && downloadIndex > callbackIndex,
    "export jobs should enter the processing gate before loading their canonical build",
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
    if (previousWorkerId === undefined) {
      delete process.env.CUSTOM_BUILD_WORKER_ID;
    } else {
      process.env.CUSTOM_BUILD_WORKER_ID = previousWorkerId;
    }
    if (previousWorkerConcurrency === undefined) {
      delete process.env.CUSTOM_BUILD_WORKER_CONCURRENCY;
    } else {
      process.env.CUSTOM_BUILD_WORKER_CONCURRENCY = previousWorkerConcurrency;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
