import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { CustomBuildJob } from "@prisma/client";

const require = createRequire(import.meta.url);
let sourceVisible = true;
let active = true;
let existingOwned = false;
let copies = 0;
let hideDuringCopy = true;
let creates = 0;
let prepared = 0;
let activations = 0;
const deleted: string[] = [];
const build = { id: "arena-build", active: true, voxelSha256: "checksum", voxelStoragePath: "gallery/prompt/model-source-g256-simple-precise.json.gz" };
const mock = (path: string, exports: unknown) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
};
const db = {
  galleryCandidate: { findFirst: async () => ({ id: "candidate" }) },
  customBuild: { findUnique: async () => sourceVisible ? {
    modelKey: "model", buildSha256: "checksum", blockCount: 1, generationTimeMs: 1,
    artifacts: [{ bucket: "builds", path: "source.json.gz", byteSize: 1 }],
  } : null },
  model: { findUnique: async () => ({ id: "model", isBaseline: false }) },
  galleryExample: { findFirst: async ({ where }: { where: { customBuild: { removedAt: null } } }) => {
    assert.equal(where.customBuild.removedAt, null);
    return sourceVisible ? { id: "example" } : null;
  } },
  build: {
    findFirst: async ({ where }: { where: { active?: boolean } }) => where.active ? active ? build : null : existingOwned ? build : null,
    create: async () => { creates++; return build; },
  },
  prompt: { updateMany: async () => { activations++; } },
  $queryRaw: async () => [],
  $transaction: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db),
};
mock("../../../lib/prisma", { prisma: db });
mock("../../../lib/storage/buildPayload", { copySupabaseStorageObject: async () => { copies++; if (hideDuringCopy) sourceVisible = false; } });
mock("../../../lib/custom-builds/storage", { deleteCustomBuildArtifact: async ({ path }: { path: string }) => { deleted.push(path); } });
mock("../../../lib/arena/artifactOwnership", { deleteArenaBuildArtifacts: async () => { deleted.push("derived-artifacts"); } });
mock("../../../lib/arena/artifactMaintenance", { maybePrecomputeArenaArtifactsForBuild: async () => { prepared++; } });

async function main() {
  const { runGalleryArenaImportJob } = await import("../../../lib/gallery/arenaImportJob");
  const job = { customBuildId: "source", payload: { promptId: "prompt" } } satisfies Pick<CustomBuildJob, "customBuildId" | "payload">;
  await runGalleryArenaImportJob(job, { beforeArtifactPreparation: async () => {} });
  assert.equal(copies, 1);
  assert.equal(creates, 0, "moderation during copy prevents build creation");
  assert.equal(activations, 0);
  assert.deepEqual(deleted, ["gallery/prompt/model-source-g256-simple-precise.json.gz"]);

  sourceVisible = true;
  hideDuringCopy = false;
  await runGalleryArenaImportJob(job, { beforeArtifactPreparation: async () => { active = false; } });
  assert.equal(creates, 1);
  assert.equal(prepared, 1);
  assert.ok(deleted.includes("derived-artifacts"), "moderation during preparation purges late artifacts");
  assert.equal(deleted.filter((path) => path.endsWith(".json.gz")).length, 2);
  sourceVisible = true;
  active = true;
  existingOwned = true;
  hideDuringCopy = true;
  const deletionCount = deleted.length;
  await runGalleryArenaImportJob(job, { beforeArtifactPreparation: async () => {} });
  assert.equal(creates, 1);
  assert.equal(prepared, 2);
  assert.equal(deleted.length, deletionCount, "ordinary source removal preserves the existing Arena copy");
  console.log("gallery arena import moderation race checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
