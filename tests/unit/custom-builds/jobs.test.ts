import assert from "node:assert/strict";

(globalThis as unknown as { prisma?: unknown }).prisma = {};

async function main() {
  const {
    failCustomBuildJob,
    recoverStaleCustomBuildJobLeases,
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
  let artifactKind: string | undefined;
  let parent = { status: "running", removedAt: null as Date | null };
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
    customBuildArtifact: {
      findFirst: async (args: { where: {
        kind: { in: string[] };
        customBuild?: { removedAt: null; status: { in: string[] } };
      } }) => {
        const active = args.where.customBuild;
        if (active && (parent.removedAt !== null || !active.status.in.includes(parent.status))) return null;
        return artifactKind && args.where.kind.in.includes(artifactKind) ? { id: "saved-source" } : null;
      },
    },
    customBuild: {
      updateMany: async (args: {
        where: { status: { in: string[] }; removedAt?: null };
        data: Record<string, unknown>;
      }) => {
        operations.push("customBuild.updateMany");
        if (!args.where.status.in.includes(parent.status) ||
          (args.where.removedAt === null && parent.removedAt !== null)) return { count: 0 };
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
    "expired jobs without reusable output should keep terminal cleanup",
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

  for (const kind of ["preview_svg", "raw_text_debug", "build_json"]) {
    artifactKind = kind;
    queryCount = 0;
    customBuildUpdates.length = 0;
    operations.length = 0;
    await recoverStaleCustomBuildJobLeases(rootClient as never);
    const recoverable = kind !== "preview_svg";
    assert.deepEqual(customBuildUpdates.map((update) => update.data.errorCode), ["provider_key_expired", "lease_expired"]);
    for (const { data } of customBuildUpdates) {
      assert.equal(data.status, "failed");
      assert.equal(data.errorRetryable, recoverable, `${kind} recovery eligibility`);
      assert.equal(data.deletionPendingAt === null, recoverable, `${kind} source retention`);
    }
    assert.equal(operations.filter((operation) => operation === "customBuildSecret.deleteMany").length, 3,
      "retaining output must not retain expired provider credentials");
  }
  for (const state of [{ status: "canceled", removedAt: null }, { status: "running", removedAt: new Date() }]) {
    parent = state;
    queryCount = 0;
    customBuildUpdates.length = 0;
    await recoverStaleCustomBuildJobLeases(rootClient as never);
    assert.equal(customBuildUpdates.length, 0, "lease recovery must preserve cancellation and removal");
  }

  const terminalOperations: string[] = [];
  const parentFailures: Array<Record<string, unknown>> = [];
  let attempts = 3;
  artifactKind = undefined;
  parent = { status: "running", removedAt: null };
  const terminalTx = {
    customBuildJob: {
      updateMany: async () => {
        terminalOperations.push("customBuildJob.updateMany");
        return { count: 1 };
      },
    },
    customBuild: {
      updateMany: async (args: {
        where: { status: { in: string[] }; removedAt?: null };
        data: Record<string, unknown>;
      }) => {
        terminalOperations.push("customBuild.updateMany");
        if (!args.where.status.in.includes(parent.status) ||
          (args.where.removedAt === null && parent.removedAt !== null)) return { count: 0 };
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
    customBuildArtifact: txClient.customBuildArtifact,
    customBuildSecret: terminalTx.customBuildSecret,
    customBuildJob: {
      findFirst: async () => ({
        attempts,
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

  for (const kind of ["raw_text_debug", "build_json"]) {
    artifactKind = kind;
    terminalOperations.length = 0;
    parentFailures.length = 0;
    await failCustomBuildJob("terminal-job-row", "worker-row", { code: "worker_failed", message: "database write failed" }, terminalRoot as never);
    assert.equal(parentFailures[0]?.errorCode, "artifact_bookkeeping_failed");
    assert.equal(parentFailures[0]?.errorMessage, "database write failed", "the underlying failure must remain visible");
    assert.equal(parentFailures[0]?.errorRetryable, true);
    assert.equal(parentFailures[0]?.deletionPendingAt, null, `${kind} must survive a terminal worker failure`);
    attempts = 1;
    terminalOperations.length = 0;
    parentFailures.length = 0;
    assert.deepEqual(await failCustomBuildJob("retry-job", "worker-row", { code: "worker_failed", message: "write failed" }, terminalRoot as never), { requeued: true });
    assert.deepEqual(terminalOperations, ["customBuildSecret.deleteMany", "customBuildJob.updateMany.outsideTransaction"],
      "automatic source recovery must discard credentials before queueing");
    assert.equal(parentFailures.length, 0);
    attempts = 3;
  }
  for (const state of [{ status: "canceled", removedAt: null }, { status: "running", removedAt: new Date() }]) {
    parent = state;
    parentFailures.length = 0;
    await failCustomBuildJob("terminal-job-row", "worker-row", { code: "worker_failed", message: "write failed" }, terminalRoot as never);
    assert.equal(parentFailures.length, 0, "fallback failure handling must preserve cancellation and removal");
  }

  console.log("custom build stale job recovery checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
