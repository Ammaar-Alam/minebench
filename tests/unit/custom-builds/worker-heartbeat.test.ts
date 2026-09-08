import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

(globalThis as unknown as { prisma?: unknown }).prisma = {};
const previousLeaseSeconds = process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS;
const originalInterval = globalThis.setInterval;
const originalNow = Date.now;
const originalWarn = console.warn;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  const { startGenerationJobHeartbeat } = await import("../../../lib/custom-builds/worker");
  const { renewCustomBuildJobLease } = await import("../../../lib/custom-builds/jobs");
  const { renewStealthGenerationJobLease } = await import("../../../lib/stealth/jobs");
  process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS = "180";
  let now = 0;
  let tick!: () => void;
  const warnings: string[] = [];
  Date.now = () => now;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  globalThis.setInterval = ((callback: () => void, interval: number) => {
    assert.equal(interval, 30_000);
    tick = callback;
    return 1 as unknown as NodeJS.Timeout;
  }) as typeof setInterval;
  const advance = async (time: number) => { now = time; tick(); await flush(); };
  const unavailable = () => Object.assign(new Error("database unavailable"), { code: "P1001" });
  const conflict = () => new Prisma.PrismaClientKnownRequestError("write conflict", {
    code: "P2034", clientVersion: Prisma.prismaVersion.client,
  });

  for (const kind of ["custom", "stealth"]) {
    let owner = "worker-a";
    let calls = 0;
    let outcomes: Array<Error | Promise<Array<{ id: string }>>> = [];
    let job: { id: string; leaseExpiresAt: Date | null };
    let controller: AbortController;
    const client = {
      $queryRaw: async (_query: TemplateStringsArray, ...bindings: unknown[]) => {
        calls += 1;
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        if (outcome) return outcome;
        return bindings.at(-1) === owner ? [{ id: "owned-job" }] : [];
      },
    };
    const reset = (expiresAt = 180_000) => {
      now = 0;
      calls = 0;
      owner = "worker-a";
      outcomes = [];
      warnings.length = 0;
      job = { id: "owned-job", leaseExpiresAt: new Date(expiresAt) };
      controller = new AbortController();
      startGenerationJobHeartbeat(job, controller, () => kind === "custom"
        ? renewCustomBuildJobLease(job.id, "worker-a", client as never)
        : renewStealthGenerationJobLease(job.id, "worker-a", 180, client as never));
    };

    reset();
    for (let time = 30_000; time <= 300_000; time += 30_000) await advance(time);
    assert.equal(job!.leaseExpiresAt?.getTime(), 480_000, "long provider waits must refresh confirmed ownership");
    outcomes.push(unavailable());
    await advance(330_000);
    assert.equal(controller!.signal.aborted, false);
    await advance(360_000);
    outcomes.push(conflict());
    await advance(390_000);
    assert.equal(controller!.signal.aborted, false, "successful renewal resets the one-failure allowance");
    outcomes.push(unavailable());
    await advance(420_000);
    assert.equal(controller!.signal.aborted, true, "a second consecutive renewal failure must abort");
    assert.equal(warnings.length, 2, "each tolerated failure remains observable");
    assert.match(warnings[0]!, /database unavailable/);
    assert.match(warnings[1]!, /write conflict/);

    reset();
    owner = "worker-b";
    await advance(30_000);
    assert.equal(controller!.signal.aborted, true, "ownership loss must abort immediately");
    assert.equal(warnings.length, 0);
    reset();
    outcomes.push(new Error("invalid renewal query"));
    await advance(30_000);
    assert.equal(controller!.signal.aborted, true, "unknown failures must not be retried");
    reset(60_000);
    outcomes.push(unavailable());
    await advance(30_000);
    assert.equal(controller!.signal.aborted, true, "retry cannot begin at the confirmed expiry boundary");
    reset();
    outcomes.push(unavailable());
    await advance(30_000);
    await advance(180_000);
    assert.equal(calls, 1, "a delayed retry must not renew an already expired lease");
    assert.equal(controller!.signal.aborted, true);

    reset();
    let resolve!: (rows: Array<{ id: string }>) => void;
    outcomes.push(new Promise((done) => { resolve = done; }));
    await advance(30_000);
    await advance(60_000);
    assert.equal(calls, 1, "renewals must not overlap");
    now = 80_000;
    resolve([{ id: job!.id }]);
    await flush();
    assert.equal(job!.leaseExpiresAt?.getTime(), 210_000, "confirmed expiry starts when renewal begins, not when it returns");
    job!.leaseExpiresAt = new Date(1_800_000);
    outcomes.push(unavailable());
    await advance(600_000);
    assert.equal(controller!.signal.aborted, false, "confirmed processing extensions must remain visible to heartbeat retries");

    reset();
    outcomes.push(new Promise((done) => { resolve = done; }));
    await advance(30_000);
    await advance(180_000);
    assert.equal(controller!.signal.aborted, true, "a hung renewal cannot outlive the confirmed lease");
    resolve([{ id: job!.id }]);
    await flush();
    assert.equal(job!.leaseExpiresAt?.getTime(), 180_000, "late results cannot restore aborted ownership");
    reset();
    outcomes.push(new Promise((done) => { resolve = done; }));
    await advance(30_000);
    now = 180_000;
    resolve([{ id: job!.id }]);
    await flush();
    assert.equal(controller!.signal.aborted, true, "late confirmation must fail closed even before the next timer fires");
  }
  console.log("generation worker heartbeat retry checks passed");
}

main().finally(() => {
  Date.now = originalNow;
  globalThis.setInterval = originalInterval;
  console.warn = originalWarn;
  if (previousLeaseSeconds === undefined) delete process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS;
  else process.env.CUSTOM_BUILD_JOB_LEASE_SECONDS = previousLeaseSeconds;
}).catch((error) => { console.error(error); process.exitCode = 1; });
