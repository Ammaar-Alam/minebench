import assert from "node:assert/strict";

(globalThis as unknown as { prisma?: unknown }).prisma = {};

async function main() {
  const {
    failCustomBuildJob,
    recoverStaleCustomBuildJobLeases,
    releaseCustomBuildJob,
    renewCustomBuildJobLease,
  } = await import("../../../lib/custom-builds/jobs");

  let renewalQuery = "";
  const renewed = await renewCustomBuildJobLease("job-row", "worker-row", {
    $queryRaw: async (strings: TemplateStringsArray) => {
      renewalQuery = strings.join("?");
      return [{ id: "job-row" }];
    },
  } as never);
  assert.equal(renewed, true);
  assert.match(
    renewalQuery,
    /GREATEST\([\s\S]*"leaseExpiresAt"/,
    "heartbeat renewal should never shorten an extended lease",
  );

  const operations: string[] = [];
  const customBuildUpdates: Array<{ data: Record<string, unknown> }> = [];
  let queryCount = 0;
  const txClient = {
    $queryRaw: async () => {
      queryCount += 1;
      operations.push(`$queryRaw.${queryCount}`);
      if (queryCount === 1) {
        return [{ id: "expired-queued-job", customBuildId: "expired-custom-build-row", type: "generate" }];
      }
      if (queryCount === 2) {
        return [{ id: "requeued-job" }];
      }
      return [{ id: "failed-job", customBuildId: "custom-build-row", type: "generate" }];
    },
    customBuild: {
      updateMany: async (args: { data: Record<string, unknown> }) => {
        operations.push("customBuild.updateMany");
        customBuildUpdates.push(args);
        return { count: 1 };
      },
    },
    customBuildSecret: {
      deleteMany: async () => {
        operations.push("customBuildSecret.deleteMany");
        return { count: 1 };
      },
    },
  };
  const rootClient = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      operations.push("$transaction.begin");
      const result = await callback(txClient);
      operations.push("$transaction.commit");
      return result;
    },
  };

  const result = await recoverStaleCustomBuildJobLeases(rootClient as never);
  assert.deepEqual(result, { requeued: 1, failed: 2 });
  assert.equal(customBuildUpdates.length, 2);
  assert.equal(
    customBuildUpdates.every((update) => update.data.deletionPendingAt instanceof Date),
    true,
    "terminal lease recovery should schedule cleanup for any partially persisted artifacts",
  );
  assert.deepEqual(operations, [
    "$transaction.begin",
    "customBuildSecret.deleteMany",
    "$queryRaw.1",
    "customBuild.updateMany",
    "customBuildSecret.deleteMany",
    "$queryRaw.2",
    "$queryRaw.3",
    "customBuild.updateMany",
    "customBuildSecret.deleteMany",
    "$transaction.commit",
  ]);

  const terminalOperations: string[] = [];
  const parentFailures: Array<Record<string, unknown>> = [];
  const terminalTx = {
    customBuildJob: {
      updateMany: async () => {
        terminalOperations.push("customBuildJob.updateMany");
        return { count: 1 };
      },
    },
    customBuild: {
      updateMany: async (args: { data: Record<string, unknown> }) => {
        terminalOperations.push("customBuild.updateMany");
        parentFailures.push(args.data);
        return { count: 1 };
      },
    },
    customBuildSecret: {
      deleteMany: async () => {
        terminalOperations.push("customBuildSecret.deleteMany");
        return { count: 1 };
      },
    },
  };
  const terminalRoot = {
    customBuildJob: {
      findFirst: async () => ({
        attempts: 3,
        maxAttempts: 3,
        customBuildId: "terminal-build-row",
        type: "generate",
      }),
      updateMany: async () => {
        terminalOperations.push("customBuildJob.updateMany.outsideTransaction");
        return { count: 1 };
      },
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      terminalOperations.push("$transaction.begin");
      const value = await callback(terminalTx);
      terminalOperations.push("$transaction.commit");
      return value;
    },
  };
  const terminalResult = await failCustomBuildJob(
    "terminal-job-row",
    "worker-row",
    { code: "worker_failed", message: "worker failed" },
    terminalRoot as never,
  );
  assert.deepEqual(terminalResult, { requeued: false });
  assert.deepEqual(terminalOperations, [
    "$transaction.begin",
    "customBuildJob.updateMany",
    "customBuild.updateMany",
    "customBuildSecret.deleteMany",
    "$transaction.commit",
  ]);
  const parentFailure = parentFailures[0];
  assert.ok(parentFailure);
  assert.equal(parentFailure?.status, "failed");
  assert.equal(parentFailure?.errorRetryable, false);
  assert.ok(parentFailure?.deletionPendingAt instanceof Date);

  let releaseQuery = "";
  const releaseUpdates: Array<Record<string, unknown>> = [];
  const releaseClient = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      releaseQuery = strings.join("?");
      return [{ id: "released-job-row", customBuildId: "released-build-row", type: "generate" }];
    },
    customBuild: {
      updateMany: async (args: { data: Record<string, unknown> }) => {
        releaseUpdates.push(args.data);
        return { count: 1 };
      },
    },
  };
  const released = await releaseCustomBuildJob("released-job-row", "worker-row", releaseClient as never);
  assert.equal(released, true);
  assert.match(releaseQuery, /status = 'queued'/);
  assert.match(releaseQuery, /attempts = GREATEST\(0, attempts - 1\)/);
  assert.equal(releaseUpdates.length, 1);
  assert.equal(releaseUpdates[0]?.status, "queued");
  assert.equal(releaseUpdates[0]?.currentStage, "queued");

  console.log("custom build stale job recovery checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
