import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { CustomBuildJob } from "@prisma/client";

const require = createRequire(import.meta.url);
let sourceVisible = true;
let active = false;
let pending = false;
let existing = false;
let copies = 0;
let creates = 0;
let activations = 0;
let cleanupPending = false;
let copy: () => void = () => {};
let prepare: () => void = () => {};
let cleanup: () => void = () => {};
const deleted: string[] = [];
const row = () => ({ id: "arena-build", active, arenaImportPending: pending,
  voxelSha256: "checksum", voxelStoragePath: "gallery/prompt/model-source-g256-simple-precise.json.gz" });
const mock = (path: string, exports: unknown) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
};
const db = {
  galleryCandidate: { findFirst: async () => ({ id: "candidate" }) },
  customBuild: {
    findUnique: async () => ({ removedAt: sourceVisible ? null : new Date(0), modelKey: "model",
      buildSha256: "checksum", blockCount: 1, generationTimeMs: 1,
      artifacts: sourceVisible ? [{ bucket: "builds", path: "source.json.gz", byteSize: 1 }] : [] }),
    update: async () => { cleanupPending = true; },
  },
  model: { findUnique: async () => ({ id: "model", isBaseline: false }) },
  galleryExample: { findFirst: async () => sourceVisible ? { id: "example" } : null },
  build: {
    findFirst: async ({ where }: { where: { OR?: unknown } }) =>
      existing && (!where.OR || active || pending) ? row() : null,
    create: async ({ data }: { data: { active: boolean; arenaImportPending: boolean } }) => {
      creates++;
      assert.equal(data.active, false);
      assert.equal(data.arenaImportPending, true);
      active = false; pending = true; existing = true;
      return row();
    },
    updateMany: async () => {
      if (!active && !pending) return { count: 0 };
      active = true; pending = false; return { count: 1 };
    },
  },
  prompt: { update: async () => { activations++; } },
  $queryRaw: async () => [],
  $transaction: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db),
};
mock("../../../lib/prisma", { prisma: db });
mock("../../../lib/storage/buildPayload", { copySupabaseStorageObject: async () => { copies++; copy(); } });
mock("../../../lib/gallery/arenaImport", { deleteRetiredGalleryArenaArtifacts: async () => {
  cleanup(); deleted.push("derived-artifacts", row().voxelStoragePath);
} });
mock("../../../lib/arena/artifactMaintenance", { maybePrecomputeArenaArtifactsForBuild: async () => {
  if (!active && !pending) throw new Error("retired");
  prepare();
} });

async function main() {
  const { runGalleryArenaImportJob } = await import("../../../lib/gallery/arenaImportJob");
  const job = { customBuildId: "source", payload: { promptId: "prompt" } } satisfies Pick<CustomBuildJob, "customBuildId" | "payload">;
  const run = () => runGalleryArenaImportJob(job, { beforeArtifactPreparation: async () => {} });
  copy = () => { sourceVisible = false; active = false; pending = false; };
  cleanup = () => { throw new Error("storage unavailable"); };
  await assert.rejects(run(), /storage unavailable/);
  assert.equal(creates, 1, "the raw copy has a durable owner before copying begins");
  assert.equal(cleanupPending, true, "late storage failures keep a durable cleanup ticket");
  assert.equal(activations, 0);
  cleanup = () => {};
  await run();
  assert.equal(copies, 1, "retired imports never resume");

  sourceVisible = true; existing = false;
  copy = () => {};
  prepare = () => { throw new Error("preparation failed"); };
  await assert.rejects(run(), /preparation failed/);
  assert.equal(active, false);
  assert.equal(pending, true);
  assert.equal(activations, 0);
  assert.equal(deleted.length, 0, "unfinished imports retain their artifacts for retry");

  sourceVisible = false;
  prepare = () => {};
  await run();
  assert.equal(creates, 2, "retry keeps the original Arena build identity");
  assert.equal(copies, 2, "retry never needs the removed source");
  assert.equal(active, true);
  assert.equal(pending, false);
  assert.equal(activations, 1);
  existing = false;
  await run();
  assert.equal(copies, 2, "removed sources cannot create new imports");
  console.log("gallery arena import moderation, publication and retry checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
