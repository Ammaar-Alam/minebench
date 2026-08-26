import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("Gallery purge checks require pnpm test:integration");
    return;
  }
  const db = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 60_000);
  const deletedPaths: string[] = [];
  const { purgeDueGalleryRecords } = await import("../../../lib/gallery/purge");

  const buildData = (id: string, purgeAt: Date, path: string) => ({
    id,
    publicId: `cb_${id}`,
    ownerId,
    status: "succeeded" as const,
    currentStage: "complete",
    promptText: `Purge fixture ${id}`,
    promptSha256: id.padEnd(64, "a").slice(0, 64),
    gridSize: 64,
    palette: "simple",
    modelKind: "catalog",
    modelProvider: "openai",
    modelId: "gpt-5.4-mini",
    modelDisplayName: "GPT 5.4 Mini",
    removedAt: past,
    purgeAt,
    deletionPendingAt: past,
    storedByteSize: 10,
    artifacts: {
      create: {
        kind: "preview_svg" as const,
        format: "svg",
        bucket: "builds",
        path,
        contentType: "image/svg+xml",
        fileName: "preview.svg",
        sha256: id.padEnd(64, "b").slice(0, 64),
        byteSize: 10,
        storedByteSize: 10,
      },
    },
  });

  try {
    await db.user.createMany({
      data: [
        { id: ownerId, email: `purge-owner-${suffix}@example.test` },
        { id: adminId, email: `purge-admin-${suffix}@example.test`, isMineBenchAdmin: true },
      ],
    });
    await db.customBuild.create({ data: buildData(`${suffix}due`, past, `gallery/${suffix}/due.svg`) });
    await db.customBuild.create({ data: buildData(`${suffix}failed`, past, `gallery/${suffix}/failed.svg`) });
    await db.customBuild.create({ data: buildData(`${suffix}future`, future, `gallery/${suffix}/future.svg`) });
    const retainedBuild = await db.customBuild.create({
      data: buildData(`${suffix}retained`, future, `gallery/${suffix}/retained-preview.svg`),
    });
    await db.customBuildArtifact.create({
      data: {
        customBuildId: retainedBuild.id,
        kind: "build_json",
        format: "json.gz",
        bucket: "builds",
        path: `gallery/${suffix}/retained-build.json.gz`,
        contentType: "application/json",
        fileName: "build.json",
        sha256: "e".repeat(64),
        sourceBuildSha256: "f".repeat(64),
        byteSize: 10,
        storedByteSize: 10,
      },
    });
    await db.customBuild.create({
      data: {
        ...buildData(`${suffix}canceled`, future, `gallery/${suffix}/canceled.svg`),
        status: "canceled",
        removedAt: null,
        purgeAt: null,
      },
    });

    const dueCandidate = await db.galleryCandidate.create({
      data: {
        publicId: `gal_${suffix}due`,
        promptText: "Due prompt",
        promptKey: `${suffix}-due`,
        uploaderId: ownerId,
        removedAt: past,
        purgeAt: past,
      },
    });
    const selectedCandidate = await db.galleryCandidate.create({
      data: {
        publicId: `gal_${suffix}selected`,
        promptText: "Selected prompt",
        promptKey: `${suffix}-selected`,
        uploaderId: ownerId,
        removedAt: past,
        purgeAt: past,
        selectedAt: past,
        selectedById: adminId,
      },
    });
    const activeDueCandidate = await db.galleryCandidate.create({
      data: {
        publicId: `gal_${suffix}active`,
        promptText: "Active prompt with stale purge metadata",
        promptKey: `${suffix}-active`,
        uploaderId: ownerId,
        purgeAt: past,
      },
    });
    const hiddenDueCandidate = await db.galleryCandidate.create({
      data: {
        publicId: `gal_${suffix}hidden`,
        promptText: "Admin-hidden prompt",
        promptKey: `${suffix}-hidden`,
        uploaderId: ownerId,
        adminHiddenAt: past,
        purgeAt: past,
      },
    });
    const retainedCandidate = await db.galleryCandidate.create({
      data: {
        publicId: `gal_${suffix}retained`,
        promptText: "Retained preview prompt",
        promptKey: `${suffix}-retained`,
        uploaderId: ownerId,
      },
    });
    await db.galleryExample.create({
      data: {
        candidateId: retainedCandidate.id,
        customBuildId: retainedBuild.id,
        contributorId: ownerId,
        adminHiddenAt: past,
        purgeAt: future,
        previewRetained: true,
      },
    });
    const futureRecord = await db.galleryModerationRecord.create({
      data: { kind: "APPEAL", target: "ACCOUNT", actorUserId: ownerId, purgeAt: future },
    });
    const dueRecord = await db.galleryModerationRecord.create({
      data: { kind: "ADMIN_ACTION", target: "CANDIDATE", candidateId: dueCandidate.id, purgeAt: past },
    });
    const expiredBuild = await db.customBuild.create({
      data: {
        ...buildData(`${suffix}secret`, future, `gallery/${suffix}/secret.svg`),
        removedAt: null,
        purgeAt: null,
        deletionPendingAt: null,
        secret: {
          create: {
            provider: "openai",
            keyCiphertext: "ciphertext",
            keyIv: "iv",
            expiresAt: past,
          },
        },
      },
    });

    const result = await purgeDueGalleryRecords(
      { minebenchAdmin: true },
      {
        now,
        limit: 20,
        deleteArtifact: async ({ path }) => {
          if (path.endsWith("failed.svg")) throw new Error("storage unavailable");
          deletedPaths.push(path);
        },
      },
    );

    assert.equal(result.expiredSecrets, 1);
    assert.equal(result.objectDeletionFailures, 1);
    assert.equal(result.generations, 1);
    assert.equal(result.candidates, 2);
    assert.equal(result.moderationRecords, 1);
    assert.deepEqual(deletedPaths.sort(), [
      `gallery/${suffix}/canceled.svg`,
      `gallery/${suffix}/due.svg`,
      `gallery/${suffix}/future.svg`,
      `gallery/${suffix}/retained-build.json.gz`,
    ]);
    assert.equal(await db.customBuild.count({ where: { id: `${suffix}due` } }), 0);
    assert.equal(await db.customBuild.count({ where: { id: `${suffix}failed` } }), 1);
    assert.match((await db.customBuild.findUniqueOrThrow({ where: { id: `${suffix}failed` } })).deletionError ?? "", /storage unavailable/);
    assert.equal(await db.customBuild.count({ where: { id: `${suffix}future` } }), 1);
    const retained = await db.customBuild.findUniqueOrThrow({
      where: { id: retainedBuild.id },
      include: { artifacts: true },
    });
    assert.deepEqual(retained.artifacts.map((artifact) => artifact.kind), ["preview_svg"]);
    assert.equal(retained.deletionPendingAt, null);
    const canceled = await db.customBuild.findUniqueOrThrow({
      where: { id: `${suffix}canceled` },
      include: { artifacts: true },
    });
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.artifacts.length, 0);
    assert.equal(canceled.deletionPendingAt, null);
    assert.equal(await db.customBuildSecret.count({ where: { customBuildId: expiredBuild.id } }), 0);
    assert.equal(await db.galleryCandidate.count({ where: { id: dueCandidate.id } }), 0);
    assert.equal(await db.galleryCandidate.count({ where: { id: selectedCandidate.id } }), 1);
    assert.equal(await db.galleryCandidate.count({ where: { id: activeDueCandidate.id } }), 1);
    assert.equal(await db.galleryCandidate.count({ where: { id: hiddenDueCandidate.id } }), 0);
    assert.equal(await db.galleryModerationRecord.count({ where: { id: dueRecord.id } }), 0);
    assert.equal(await db.galleryModerationRecord.count({ where: { id: futureRecord.id } }), 1);

    console.log("Gallery bounded purge checks passed");
  } finally {
    await db.galleryModerationRecord.deleteMany({ where: { actorUserId: ownerId } });
    await db.galleryCandidate.deleteMany({ where: { uploaderId: ownerId } });
    await db.customBuild.deleteMany({ where: { ownerId } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, adminId] } } });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
