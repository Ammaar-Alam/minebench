import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { resetMetricLogWriter, setMetricLogWriter } from "../../../lib/observability/cloudwatch";

const previousPoll = process.env.CUSTOM_BUILD_WORKER_POLL_MS;
const previousConcurrency = process.env.CUSTOM_BUILD_WORKER_CONCURRENCY;
process.env.CUSTOM_BUILD_WORKER_POLL_MS = "250";
process.env.CUSTOM_BUILD_WORKER_CONCURRENCY = "2";

const transient = (code: string) => new Prisma.PrismaClientKnownRequestError("Transaction already closed", {
  code, clientVersion: Prisma.prismaVersion.client,
});
const operations: string[] = [];
const recoveries: number[] = [];
let claimed = false;
let claimFailed = false;
let disconnects = 0;
let fatal = false;
let unavailable = false;
let releaseBuild!: (value: unknown) => void;
let recovered!: () => void;
const build = new Promise((resolve) => { releaseBuild = resolve; });
const retried = new Promise<void>((resolve) => { recovered = resolve; });
const transaction = {
  customBuildSecret: {
    deleteMany: async () => {
      recoveries.push(Date.now());
      if (fatal) throw new Error("Invalid queue configuration");
      if (unavailable || recoveries.length === 2) throw transient("P2028");
      if (recoveries.length === 4) recovered();
      return { count: 0 };
    },
  },
  $queryRaw: async () => [],
  customBuildEvent: {
    aggregate: async () => ({ _max: { seq: 0 } }),
    create: async () => { operations.push("export_complete"); return {}; },
  },
};
const fakePrisma = {
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(transaction),
  $queryRaw: async (parts: TemplateStringsArray) => {
    const sql = parts.join("?");
    if (!sql.includes("WITH candidate") || !sql.includes('FROM "CustomBuildJob"')) return [];
    if (recoveries.length === 3 && !claimFailed) {
      claimFailed = true;
      throw transient("P1001");
    }
    if (claimed) return [];
    claimed = true;
    return [{ id: "active-export", customBuildId: "build-row", type: "export", payload: { format: "glb" } }];
  },
  customBuild: { findUnique: async () => build },
  customBuildArtifact: { findFirst: async () => ({ id: "existing-export" }) },
  customBuildJob: {
    findFirst: async () => null,
    count: async () => 0,
    updateMany: async () => { operations.push("job_complete"); return { count: 1 }; },
  },
  stealthGenerationResult: { findFirst: async () => null, count: async () => 0 },
  $disconnect: async () => { disconnects += 1; operations.push("disconnect"); },
};
(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

async function main() {
  const { runCustomBuildWorkerLoop } = await import("../../../lib/custom-builds/worker");
  const originalListeners = process.listeners("SIGTERM");
  const initialListeners = originalListeners.length;
  // invoke the registered handler without signaling the test runner
  const signalWorker = () => process.listeners("SIGTERM")
    .filter((listener) => !originalListeners.includes(listener))
    .forEach((listener) => listener("SIGTERM"));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  let onWarning = () => {};
  let loop: Promise<void> | undefined;
  const timeout = setTimeout(() => { console.error("worker loop regression timed out"); process.exit(1); }, 10_000);
  setMetricLogWriter(() => {});
  console.warn = (message: unknown) => { warnings.push(String(message)); onWarning(); };
  try {
    loop = runCustomBuildWorkerLoop("loop-test");
    await Promise.race([retried, loop.then(() => { throw new Error("Worker exited before retrying"); })]);
    assert.equal(claimed, true);
    assert.equal(claimFailed, true);
    assert.equal(disconnects, 0, "poll failures must not disconnect an active job");
    assert.ok(recoveries[2]! - recoveries[1]! >= 200, "recovery retries must back off");
    assert.ok(recoveries[3]! - recoveries[2]! >= 450, "consecutive claim failures must increase the delay");
    assert.match(warnings[0]!, /retrying in 250ms/);
    assert.match(warnings[1]!, /retrying in 500ms/);
    signalWorker();
    assert.equal(disconnects, 0, "SIGTERM must drain the active job");
    releaseBuild({ id: "build-row", publicId: "cb_existing", status: "succeeded", buildSha256: "a".repeat(64) });
    await loop;
    assert.deepEqual(operations, ["export_complete", "job_complete", "disconnect"]);
    assert.equal(process.listenerCount("SIGTERM"), initialListeners);

    unavailable = true;
    process.env.CUSTOM_BUILD_WORKER_POLL_MS = "60000";
    const waiting = new Promise<void>((resolve) => { onWarning = resolve; });
    loop = runCustomBuildWorkerLoop("shutdown-test");
    await waiting;
    signalWorker();
    await loop;
    assert.equal(disconnects, 2, "shutdown must interrupt a long retry delay");
    assert.equal(process.listenerCount("SIGTERM"), initialListeners);

    fatal = true;
    loop = runCustomBuildWorkerLoop("fatal-test");
    await assert.rejects(loop, /Invalid queue configuration/);
    assert.equal(disconnects, 3);
    assert.equal(process.listenerCount("SIGTERM"), initialListeners);
    console.log("custom build worker loop recovery checks passed");
  } finally {
    signalWorker();
    releaseBuild(null);
    await loop?.catch(() => {});
    clearTimeout(timeout);
    console.warn = originalWarn;
    resetMetricLogWriter();
    if (previousPoll === undefined) delete process.env.CUSTOM_BUILD_WORKER_POLL_MS;
    else process.env.CUSTOM_BUILD_WORKER_POLL_MS = previousPoll;
    if (previousConcurrency === undefined) delete process.env.CUSTOM_BUILD_WORKER_CONCURRENCY;
    else process.env.CUSTOM_BUILD_WORKER_CONCURRENCY = previousConcurrency;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
