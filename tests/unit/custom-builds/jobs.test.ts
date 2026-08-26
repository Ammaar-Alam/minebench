import assert from "node:assert/strict";

(globalThis as unknown as { prisma?: unknown }).prisma = {};

async function main() {
  const { recoverStaleCustomBuildJobLeases } = await import("../../../lib/custom-builds/jobs");

  const operations: string[] = [];
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
      updateMany: async () => {
        operations.push("customBuild.updateMany");
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
  assert.deepEqual(operations, [
    "$transaction.begin",
    "$queryRaw.1",
    "customBuild.updateMany",
    "customBuildSecret.deleteMany",
    "$queryRaw.2",
    "$queryRaw.3",
    "customBuild.updateMany",
    "customBuildSecret.deleteMany",
    "$transaction.commit",
  ]);

  console.log("custom build stale job recovery checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
