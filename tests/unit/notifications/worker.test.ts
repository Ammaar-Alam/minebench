import assert from "node:assert/strict";
import { setMetricLogWriter } from "../../../lib/observability/cloudwatch";

process.env.APNS_ENABLED = "true";
process.env.CUSTOM_BUILD_WORKER_CONCURRENCY = "1";
setMetricLogWriter(() => {});

const timers = new Map<object, () => void>();
let tick!: () => void;
globalThis.setInterval = ((callback: () => void, delay: number) => {
  const timer = {};
  timers.set(timer, callback);
  if (delay === 5_000) tick = callback;
  return timer;
}) as typeof setInterval;
globalThis.clearInterval = ((timer: object) => { timers.delete(timer); }) as typeof clearInterval;

let jobClaimed = false;
let buildStarted = false;
let claims = 0;
let disconnected = false;
let releaseClaim!: (rows: never[]) => void;
let releaseBuild!: (row: unknown) => void;
const build = new Promise((resolve) => { releaseBuild = resolve; });
const transaction = {
  customBuildSecret: { deleteMany: async () => ({ count: 0 }) },
  $queryRaw: async () => [],
  customBuildEvent: { aggregate: async () => ({ _max: { seq: 0 } }), create: async () => ({}) },
};
(globalThis as unknown as { prisma: unknown }).prisma = {
  $transaction: async (callback: (tx: unknown) => unknown) => callback(transaction),
  $queryRaw: async (parts: TemplateStringsArray) => {
    const sql = parts.join("?");
    if (sql.includes('FROM "PushDelivery"')) {
      claims += 1;
      if (claims === 1) throw new Error("temporary database outage");
      return new Promise<never[]>((resolve) => { releaseClaim = resolve; });
    }
    if (!sql.includes('FROM "CustomBuildJob"') || jobClaimed) return [];
    jobClaimed = true;
    return [{ id: "export-job", customBuildId: "build", type: "export", payload: { format: "glb" } }];
  },
  $executeRaw: async () => 0,
  customBuild: { findUnique: async () => { buildStarted = true; return build; } },
  customBuildArtifact: { findFirst: async () => ({ id: "existing-export" }) },
  customBuildJob: { findFirst: async () => null, count: async () => 0, updateMany: async () => ({ count: 1 }) },
  stealthGenerationResult: { findFirst: async () => null, count: async () => 0 },
  pushDelivery: { updateMany: async () => ({ count: 0 }) },
  $disconnect: async () => { disconnected = true; },
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const deadline = setTimeout(() => { console.error("notification worker check timed out"); process.exit(1); }, 10_000);

async function main() {
  const { runCustomBuildWorkerLoop } = await import("../../../lib/custom-builds/worker");
  const oldListeners = process.listeners("SIGTERM");
  const loop = runCustomBuildWorkerLoop("notification-worker-test");
  await flush();
  assert.equal(buildStarted, true, "the only generation slot must be occupied");
  assert.equal(claims, 1, "notification delivery starts immediately");
  tick();
  await flush();
  assert.equal(claims, 2, "notification delivery retries while the generation remains active");
  tick();
  await flush();
  assert.equal(claims, 2, "an unfinished notification batch must not overlap another tick");
  releaseClaim([]);
  await flush();

  process.listeners("SIGTERM").filter((listener) => !oldListeners.includes(listener))
    .forEach((listener) => listener("SIGTERM"));
  tick();
  await flush();
  assert.equal(claims, 3, "notifications continue while generations drain after SIGTERM");
  releaseBuild({ id: "build", publicId: "cb_test", status: "succeeded", buildSha256: "a".repeat(64) });
  await flush();
  assert.equal(disconnected, false, "the worker must await its pending notification batch");
  releaseClaim([]);
  await loop;
  assert.equal(disconnected, true);
  assert.equal(timers.size, 0, "shutdown clears every worker interval");
  console.log("notification worker lifecycle checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); }).finally(() => clearTimeout(deadline));
