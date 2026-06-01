import assert from "node:assert/strict";

(globalThis as unknown as { prisma?: unknown }).prisma = {};

async function main() {
  const { recoverStaleCustomBuildJobLeases } = await import("../../../lib/custom-builds/jobs");

  const operations: string[] = [];
  let queryCount = 0;
  const txClient = {
    $queryRaw: async () => {
      operations.push("$queryRaw");
      queryCount += 1;
      return queryCount === 1
        ? [{ id: "requeued-job" }]
        : [{ id: "failed-job", customBuildId: "custom-build-row", type: "generate" }];
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
  assert.deepEqual(result, { requeued: 1, failed: 1 });
  assert.deepEqual(operations, [
    "$transaction.begin",
    "$queryRaw",
    "$queryRaw",
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
