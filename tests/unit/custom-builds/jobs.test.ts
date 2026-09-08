import assert from "node:assert/strict";

(globalThis as unknown as { prisma?: unknown }).prisma = {};

const previousEmailNotificationsEnabled = process.env.EMAIL_NOTIFICATIONS_ENABLED;
const previousApnsEnabled = process.env.APNS_ENABLED;
process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
process.env.APNS_ENABLED = "false";

function sqlText(args: unknown[]) {
  const first = args[0];
  if (!first) return "";
  if (Array.isArray(first)) return first.join("?");
  if (typeof first !== "object") return "";
  const query = first as { sql?: unknown; text?: unknown; strings?: unknown };
  if (typeof query.sql === "string") return query.sql;
  if (typeof query.text === "string") return query.text;
  return Array.isArray(query.strings) ? query.strings.join("?") : "";
}

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
  const secretDeletes: Array<{ where?: Record<string, unknown> }> = [];
  let queryCount = 0;
  const txClient = {
    $queryRaw: async (...args: unknown[]) => {
      if (sqlText(args).includes('FROM "User"')) {
        operations.push("lockNotificationAccounts");
        return [{ id: "owner-row" }];
      }
      queryCount += 1;
      operations.push(`$queryRaw.${queryCount}`);
      if (queryCount === 1) {
        return [{ customBuildId: "retryable-secret-build-row", ownerId: "owner-row" }];
      }
      if (queryCount === 2) {
        return [{ id: "expired-queued-job", customBuildId: "expired-custom-build-row", type: "generate", ownerId: "owner-row" }];
      }
      if (queryCount === 3) {
        return [{ id: "requeued-job", ownerId: "owner-row" }];
      }
      if (queryCount === 4) {
        return [{ id: "failed-job", customBuildId: "custom-build-row", type: "generate", ownerId: "owner-row" }];
      }
      if (queryCount === 5) {
        return [{ id: "expired-queued-job", customBuildId: "expired-custom-build-row", type: "generate" }];
      }
      if (queryCount === 6) {
        return [{ id: "requeued-job" }];
      }
      return [{ id: "failed-job", customBuildId: "custom-build-row", type: "generate" }];
    },
    $executeRaw: async () => {
      operations.push("notificationDelivery.insert");
      return 0;
    },
    user: {
      findFirst: async () => ({ notificationPreference: null }),
    },
    customBuild: {
      findFirst: async (args: { where: { id: string } }) => {
        operations.push("customBuild.findFirst");
        return {
          id: args.where.id,
          publicId: `cb_${args.where.id}`,
          ownerId: "owner-row",
          status: "failed",
          completedAt: new Date(),
        };
      },
      updateMany: async (args: { data: Record<string, unknown> }) => {
        operations.push("customBuild.updateMany");
        customBuildUpdates.push(args);
        return { count: 1 };
      },
    },
    customBuildSecret: {
      deleteMany: async (args?: { where?: Record<string, unknown> }) => {
        operations.push("customBuildSecret.deleteMany");
        secretDeletes.push(args ?? {});
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
  assert.deepEqual(
    secretDeletes[0]?.where?.customBuildId,
    { in: ["retryable-secret-build-row"] },
    "expired retryable credential cleanup should stay limited to preselected builds",
  );
  assert.ok(
    (secretDeletes[0]?.where?.expiresAt as { lte?: unknown } | undefined)?.lte instanceof Date,
    "expired retryable credential cleanup should recheck the recovery cutoff",
  );
  assert.deepEqual(
    secretDeletes[0]?.where?.customBuild,
    { status: "failed", errorRetryable: true },
    "expired retryable credential cleanup should recheck the parent build state",
  );
  assert.deepEqual(operations, [
    "$transaction.begin",
    "$queryRaw.1",
    "$queryRaw.2",
    "$queryRaw.3",
    "$queryRaw.4",
    "lockNotificationAccounts",
    "customBuildSecret.deleteMany",
    "$queryRaw.5",
    "customBuild.updateMany",
    "customBuild.findFirst",
    "notificationDelivery.insert",
    "customBuildSecret.deleteMany",
    "$queryRaw.6",
    "$queryRaw.7",
    "customBuild.updateMany",
    "customBuild.findFirst",
    "notificationDelivery.insert",
    "customBuildSecret.deleteMany",
    "$transaction.commit",
  ]);

  const terminalOperations: string[] = [];
  const parentFailures: Array<Record<string, unknown>> = [];
  const terminalTx = {
    $queryRaw: async (...args: unknown[]) => {
      if (sqlText(args).includes('FROM "User"')) {
        terminalOperations.push("lockNotificationAccounts");
        return [{ id: "terminal-owner-row" }];
      }
      return [];
    },
    $executeRaw: async () => {
      terminalOperations.push("notificationDelivery.insert");
      return 0;
    },
    user: {
      findFirst: async () => ({ notificationPreference: null }),
    },
    customBuildJob: {
      updateMany: async () => {
        terminalOperations.push("customBuildJob.updateMany");
        return { count: 1 };
      },
    },
    customBuild: {
      findFirst: async () => {
        terminalOperations.push("customBuild.findFirst");
        return {
          id: "terminal-build-row",
          publicId: "cb_terminal",
          ownerId: "terminal-owner-row",
          status: "failed",
          completedAt: new Date(),
        };
      },
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
        customBuild: { ownerId: "terminal-owner-row" },
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
    "lockNotificationAccounts",
    "customBuildJob.updateMany",
    "customBuild.updateMany",
    "customBuild.findFirst",
    "notificationDelivery.insert",
    "customBuildSecret.deleteMany",
    "$transaction.commit",
  ]);
  const parentFailure = parentFailures[0];
  assert.ok(parentFailure);
  assert.equal(parentFailure?.status, "failed");
  assert.equal(parentFailure?.errorRetryable, false);
  assert.ok(parentFailure?.deletionPendingAt instanceof Date);

  console.log("custom build stale job recovery checks passed");
}

main()
  .finally(() => {
    if (previousEmailNotificationsEnabled === undefined) {
      delete process.env.EMAIL_NOTIFICATIONS_ENABLED;
    } else {
      process.env.EMAIL_NOTIFICATIONS_ENABLED = previousEmailNotificationsEnabled;
    }
    if (previousApnsEnabled === undefined) {
      delete process.env.APNS_ENABLED;
    } else {
      process.env.APNS_ENABLED = previousApnsEnabled;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
