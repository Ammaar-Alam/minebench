import assert from "node:assert/strict";

const now = new Date();
const artifact = (id: string) => ({ id, kind: "world_part", bucket: "builds", path: id, storedByteSize: 10n });
let artifacts = [artifact("original")];
let locked = false;
let eligible = true;
const updates: Array<Record<string, unknown>> = [];
let findPending = async () => [{ id: "removed-build", galleryExamples: [] }];
const prisma = {
  customBuild: {
    findMany: async ({ take, select }: { take: number; select: Record<string, unknown> }) => {
      assert.equal(take, 100);
      assert.equal(select.artifacts, undefined, "candidate scans must not retain every build's artifacts");
      return findPending();
    },
    findFirst: async () => eligible ? { galleryExamples: [] } : null,
    update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); },
  },
  customBuildArtifact: {
    findMany: async () => [...artifacts],
    deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      assert.equal(locked, true, "cleanup must lock its parent before reconciling artifacts");
      artifacts = artifacts.filter(({ id }) => !where.id.in.includes(id));
    },
    aggregate: async () => ({ _count: artifacts.length, _sum: { storedByteSize: BigInt(artifacts.length) * 10n } }),
  },
  $queryRaw: async () => { locked = true; return [{ id: "removed-build" }]; },
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
    locked = false;
    try { return await callback(prisma); } finally { locked = false; }
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = prisma;
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  const { purgePendingCustomBuildArtifacts, startCustomBuildCleanup } = await import("../../../lib/custom-builds/cleanup");
  const first = await purgePendingCustomBuildArtifacts({ now, deleteArtifact: async () => { artifacts.push(artifact("late")); } });
  assert.deepEqual(first, { objectsDeleted: 1, objectDeletionFailures: 0 });
  assert.deepEqual(artifacts.map(({ id }) => id), ["late"], "cleanup must delete only its original artifact snapshot");
  assert.equal(updates.at(-1)!.storedByteSize, 10n);
  assert.equal(updates.at(-1)!.objectsDeletedAt, null);
  assert.equal(updates.at(-1)!.deletionPendingAt, now, "late artifacts must retain their cleanup request");
  assert.deepEqual(await purgePendingCustomBuildArtifacts({ now, deleteArtifact: async () => {} }),
    { objectsDeleted: 1, objectDeletionFailures: 0 });
  assert.equal(updates.at(-1)!.storedByteSize, 0n);
  assert.equal(updates.at(-1)!.objectsDeletedAt, now);
  assert.equal(updates.at(-1)!.deletionPendingAt, null);

  artifacts = [artifact("recovered")];
  eligible = false;
  assert.deepEqual(await purgePendingCustomBuildArtifacts({ now, deleteArtifact: async () => {} }),
    { objectsDeleted: 0, objectDeletionFailures: 0 });
  assert.deepEqual(artifacts.map(({ id }) => id), ["recovered"], "recheck eligibility after selecting cleanup candidates");
  eligible = true;
  artifacts = [];

  let tick!: () => void;
  let cleared = false;
  globalThis.setInterval = ((callback: () => void, interval: number) => {
    assert.equal(interval, 5_000);
    tick = callback;
    return {};
  }) as typeof setInterval;
  globalThis.clearInterval = (() => { cleared = true; }) as typeof clearInterval;
  let scans = 0;
  let release!: (rows: []) => void;
  findPending = () => {
    scans += 1;
    return new Promise((resolve) => { release = resolve; });
  };
  const stop = startCustomBuildCleanup();
  assert.equal(scans, 1, "cleanup must start without waiting for the first timer");
  tick();
  assert.equal(scans, 1, "cleanup ticks must never overlap");
  release([]);
  await flush();
  tick();
  assert.equal(scans, 2);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await flush();
  assert.equal(cleared, true);
  assert.equal(stopped, false, "shutdown must wait for active cleanup");
  release([]);
  await stopping;
  assert.equal(stopped, true);
  console.log("custom build cleanup reconciliation and lifecycle checks passed");
}

void main().finally(() => {
  globalThis.setInterval = originalInterval;
  globalThis.clearInterval = originalClear;
}).catch((error) => { console.error(error); process.exitCode = 1; });
