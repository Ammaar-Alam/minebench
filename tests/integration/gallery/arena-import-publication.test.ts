import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

const require = createRequire(import.meta.url);
let prepare: () => Promise<void> = async () => {};
const moduleId = require.resolve("../../../lib/arena/artifactMaintenance");
require.cache[moduleId] = { id: moduleId, filename: moduleId, loaded: true,
  exports: { maybePrecomputeArenaArtifactsForBuild: async () => prepare() },
} as NodeJS.Module;

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) return;
  const db = new PrismaClient();
  const { prisma } = await import("../../../lib/prisma");
  const { runGalleryArenaImportJob } = await import("../../../lib/gallery/arenaImportJob");
  const { getArenaEligiblePromptIds } = await import("../../../lib/arena/eligibility");
  const { getArenaBuildMeta } = await import("../../../lib/arena/buildMetaCache");
  const { uploadArenaBuildArtifact } = await import("../../../lib/arena/artifactOwnership");
  const suffix = randomUUID();
  try {
    const owner = await db.user.create({ data: { id: randomUUID(), email: `${suffix}@example.test` } });
    const prompt = await db.prompt.create({ data: { text: `Import publication ${suffix}`, active: true } });
    const candidate = await db.galleryCandidate.create({ data: {
      publicId: `gal_${suffix}`, promptText: prompt.text, promptKey: suffix,
      uploaderId: owner.id, selectedAt: new Date(), officialPromptId: prompt.id,
    } });
    const model = await db.model.create({ data: {
      key: `pending-${suffix}`, provider: "test", modelId: suffix, displayName: "Pending import",
    } });
    const other = await db.model.create({ data: {
      key: `ready-${suffix}`, provider: "test", modelId: `${suffix}-ready`, displayName: "Ready import",
    } });
    const source = await db.customBuild.create({ data: {
      publicId: `cb_${suffix}`, ownerId: owner.id, status: "succeeded", promptText: prompt.text,
      promptSha256: "a".repeat(64), gridSize: 256, palette: "simple", mode: "precise",
      modelKind: "catalog", modelKey: model.key, modelProvider: "test", modelId: suffix, modelDisplayName: "Pending import",
    } });
    const build = await db.build.create({ data: {
      promptId: prompt.id, modelId: model.id, gridSize: 256, palette: "simple", mode: "precise",
      active: false, arenaImportPending: true, blockCount: 1, generationTimeMs: 1,
      voxelSha256: "a".repeat(64), voxelStorageBucket: "builds",
      voxelStoragePath: `gallery/${prompt.id}/${model.key}-${source.id}-g256-simple-precise.json.gz`,
    } });
    await db.build.create({ data: {
      promptId: prompt.id, modelId: other.id, gridSize: 256, palette: "simple", mode: "precise",
      active: true, blockCount: 1, generationTimeMs: 1,
    } });
    const job = { customBuildId: source.id, payload: { promptId: prompt.id } };
    assert.equal((await getArenaEligiblePromptIds()).includes(prompt.id), false);
    assert.equal(await getArenaBuildMeta(build.id, build.voxelSha256), null);
    assert.equal(await uploadArenaBuildArtifact(build.id, { bucket: "builds", path: `pending/${suffix}.mbv4` },
      async () => {}, async () => assert.fail("pending artifact was deleted")), true);
    await runGalleryArenaImportJob(job, { beforeArtifactPreparation: async () => {} });
    assert.ok((await getArenaEligiblePromptIds()).includes(prompt.id));
    assert.ok(await getArenaBuildMeta(build.id, build.voxelSha256));
    assert.equal((await db.build.findUniqueOrThrow({ where: { id: build.id } })).arenaImportPending, false);

    for (const action of ["hide", "unselect"] as const) {
      await db.build.update({ where: { id: build.id }, data: { active: false, arenaImportPending: true } });
      await db.galleryCandidate.update({ where: { id: candidate.id }, data: { adminHiddenAt: null, selectedAt: new Date() } });
      await db.prompt.update({ where: { id: prompt.id }, data: { active: true } });
      const preparing = barrier();
      const finishPreparation = barrier();
      const moderating = barrier();
      const commitModeration = barrier();
      prepare = async () => { preparing.release(); await finishPreparation.promise; };
      const importing = runGalleryArenaImportJob(job, { beforeArtifactPreparation: async () => {} });
      await preparing.promise;
      const moderation = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "GalleryCandidate" WHERE id = ${candidate.id} FOR UPDATE`;
        await tx.galleryCandidate.update({ where: { id: candidate.id }, data:
          action === "hide" ? { adminHiddenAt: new Date() } : { selectedAt: null } });
        await tx.prompt.update({ where: { id: prompt.id }, data: { active: false } });
        moderating.release();
        await commitModeration.promise;
      }, { timeout: 10_000 });
      try {
        await moderating.promise;
        finishPreparation.release();
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query LIKE '%GalleryCandidate%' AND query LIKE '%FOR UPDATE%') AS waiting
          `;
          waiting = rows[0]!.waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(waiting, "activation must wait for the candidate lock");
      } finally {
        finishPreparation.release();
        commitModeration.release();
        await Promise.all([moderation, importing]);
      }
      assert.equal((await db.prompt.findUniqueOrThrow({ where: { id: prompt.id } })).active, false);
      assert.equal((await db.build.findUniqueOrThrow({ where: { id: build.id } })).active, false);
    }
    await db.galleryCandidate.update({ where: { id: candidate.id }, data: { adminHiddenAt: null, selectedAt: new Date() } });
    prepare = async () => { throw new Error("preparation failed"); };
    await assert.rejects(runGalleryArenaImportJob(job, { beforeArtifactPreparation: async () => {} }), /preparation failed/);
    const failed = await db.build.findUniqueOrThrow({ where: { id: build.id } });
    assert.equal(failed.active, false);
    assert.equal(failed.arenaImportPending, true);
    await db.customBuild.update({ where: { id: source.id }, data: { removedAt: new Date() } });
    prepare = async () => {};
    await runGalleryArenaImportJob(job, { beforeArtifactPreparation: async () => {} });
    assert.equal((await db.build.findUniqueOrThrow({ where: { id: build.id } })).active, true);
    console.log("Arena import publication and PostgreSQL moderation race checks passed");
  } finally {
    await db.$disconnect();
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
