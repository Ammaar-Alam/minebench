import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type CustomBuildStatus } from "@prisma/client";

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("Admin generation publish checks require pnpm test:integration");
    return;
  }

  const db = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const ownerId = randomUUID();
  const nonAdminId = randomUUID();
  const suspendedId = randomUUID();
  const now = new Date("2026-09-05T16:00:00.000Z");
  const userIds = [adminId, ownerId, nonAdminId, suspendedId];

  const {
    getGalleryCandidate,
    GalleryServiceError,
    removeGalleryExample,
  } = await import("../../../lib/gallery/service");
  const {
    listAdminGenerations,
    publishAdminGeneration,
    removeSavedGeneration,
  } = await import("../../../lib/generations/service");

  async function createBuild(
    label: string,
    input: {
      targetOwnerId?: string;
      status?: CustomBuildStatus;
      removedAt?: Date | null;
      withArtifacts?: boolean;
    } = {},
  ) {
    const status = input.status ?? "succeeded";
    const publicId = `cst_publish_${label}_${suffix}`;
    return db.customBuild.create({
      data: {
        publicId,
        ownerId: input.targetOwnerId ?? ownerId,
        status,
        currentStage: status === "succeeded" ? "complete" : status,
        completedAt: status === "succeeded" ? now : null,
        removedAt: input.removedAt,
        promptText: `Admin publish prompt ${label} ${suffix}`,
        promptSha256: "a".repeat(64),
        gridSize: 64,
        palette: "simple",
        modelKind: "catalog",
        modelKey: "openai_gpt_5_4_mini",
        modelProvider: "openai",
        modelId: "gpt-5.4-mini",
        modelDisplayName: "GPT 5.4 Mini",
        blockCount: status === "succeeded" ? 4 : null,
        generationTimeMs: status === "succeeded" ? 125_000 : null,
        buildSha256: "b".repeat(64),
        buildByteSize: 100,
        buildCompressedByteSize: 60,
        storedByteSize: 120,
        artifacts: input.withArtifacts === false ? undefined : {
          create: [
            {
              kind: "build_json",
              format: "json.gz",
              bucket: "builds",
              path: `admin-publish/${suffix}/${label}.json.gz`,
              encoding: "gzip",
              contentType: "application/gzip",
              fileName: "build.json.gz",
              sha256: "c".repeat(64),
              sourceBuildSha256: "b".repeat(64),
              byteSize: 100,
              compressedByteSize: 60,
              storedByteSize: 60,
            },
            {
              kind: "viewer_mbv4",
              format: "mbv4",
              bucket: "builds",
              path: `admin-publish/${suffix}/${label}.mbv4`,
              contentType: "application/octet-stream",
              fileName: "viewer.mbv4",
              sha256: "d".repeat(64),
              sourceBuildSha256: "b".repeat(64),
              byteSize: 60,
              storedByteSize: 60,
            },
          ],
        },
      },
    });
  }

  try {
    await db.user.createMany({
      data: [
        { id: adminId, email: `publish-admin-${suffix}@example.test`, isMineBenchAdmin: true },
        { id: ownerId, email: `publish-owner-${suffix}@example.test` },
        { id: nonAdminId, email: `publish-reviewer-${suffix}@example.test` },
        { id: suspendedId, email: `publish-suspended-${suffix}@example.test`, gallerySuspendedAt: now },
      ],
    });

    const build = await createBuild("ready");
    assert.equal(
      (await listAdminGenerations(adminId, { ownerId })).items.find((item) => item.id === build.publicId)?.canPublish,
      true,
    );

    await assert.rejects(
      () => publishAdminGeneration(nonAdminId, build.publicId),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "forbidden",
    );

    const published = await publishAdminGeneration(adminId, build.publicId);
    assert.equal(published.created, true);
    const repeated = await publishAdminGeneration(adminId, build.publicId);
    assert.deepEqual(repeated, { ...published, created: false });
    assert.equal(await db.galleryExample.count({ where: { customBuildId: build.id } }), 1);
    assert.equal(await db.galleryModerationRecord.count({
      where: { action: "generation_published", actorUserId: adminId, subjectUserId: ownerId },
    }), 1);

    const candidateRow = await db.galleryCandidate.findUniqueOrThrow({
      where: { publicId: published.candidateId },
      select: { uploaderId: true, postAnonymously: true },
    });
    const exampleRow = await db.galleryExample.findUniqueOrThrow({
      where: { id: published.exampleId },
      select: { contributorId: true, postAnonymously: true },
    });
    assert.deepEqual(candidateRow, { uploaderId: ownerId, postAnonymously: true });
    assert.deepEqual(exampleRow, { contributorId: ownerId, postAnonymously: true });
    assert.equal((await db.customBuild.findUniqueOrThrow({ where: { id: build.id } })).ownerId, ownerId);

    const publicCandidate = await getGalleryCandidate(published.candidateId, { userId: ownerId });
    assert.equal(publicCandidate?.attribution, "Anonymous");
    assert.equal(publicCandidate?.canRemove, true);
    assert.equal(publicCandidate?.cover?.attribution, "Anonymous");
    assert.equal(publicCandidate?.cover?.buildId, build.publicId);
    assert.equal(
      (await listAdminGenerations(adminId, { ownerId })).items.find((item) => item.id === build.publicId)?.canPublish,
      false,
    );

    await assert.rejects(
      () => removeGalleryExample(adminId, published.candidateId, published.exampleId),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "not_found",
    );
    assert.deepEqual(await removeGalleryExample(ownerId, published.candidateId, published.exampleId), { removed: true });
    const retainedBuild = await db.customBuild.findUniqueOrThrow({
      where: { id: build.id },
      select: { ownerId: true, removedAt: true, objectsDeletedAt: true },
    });
    assert.deepEqual(retainedBuild, { ownerId, removedAt: null, objectsDeletedAt: null });
    assert.equal((await db.galleryExample.findUniqueOrThrow({ where: { id: published.exampleId } })).removedAt instanceof Date, true);
    assert.equal((await getGalleryCandidate(published.candidateId))?.exampleCount, 0);
    assert.equal(
      (await listAdminGenerations(adminId, { ownerId })).items.find((item) => item.id === build.publicId)?.canPublish,
      false,
    );
    await assert.rejects(
      () => publishAdminGeneration(adminId, build.publicId),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "generation_not_available",
    );

    const removableBuild = await createBuild("remove_saved");
    const removablePublished = await publishAdminGeneration(adminId, removableBuild.publicId);
    await assert.rejects(
      () => removeSavedGeneration(ownerId, removableBuild.publicId, { deleteArtifact: async () => undefined }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "public_examples_require_confirmation",
    );
    assert.deepEqual(
      await removeSavedGeneration(ownerId, removableBuild.publicId, {
        acknowledgePublicExamples: true,
        deleteArtifact: async () => undefined,
      }),
      { removed: true, publicExamplesRemoved: 1 },
    );
    assert.equal((await db.galleryExample.findUniqueOrThrow({ where: { id: removablePublished.exampleId } })).removedAt instanceof Date, true);
    assert.equal((await getGalleryCandidate(removablePublished.candidateId))?.exampleCount, 0);

    for (const status of ["queued", "running", "failed", "canceled"] as const) {
      const invalid = await createBuild(status, { status });
      await assert.rejects(
        () => publishAdminGeneration(adminId, invalid.publicId),
        (error: unknown) => error instanceof GalleryServiceError && error.code === "generation_not_available",
      );
    }
    const removed = await createBuild("removed", { removedAt: now });
    await assert.rejects(
      () => publishAdminGeneration(adminId, removed.publicId),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "generation_not_available",
    );
    const suspended = await createBuild("suspended", { targetOwnerId: suspendedId });
    await assert.rejects(
      () => publishAdminGeneration(adminId, suspended.publicId),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "generation_not_available",
    );

    const hidden = await createBuild("hidden");
    const hiddenCandidate = await db.galleryCandidate.create({
      data: {
        publicId: `gal_publish_hidden_${suffix}`,
        promptText: hidden.promptText,
        promptKey: `admin-publish-hidden-${suffix}`,
        uploaderId: ownerId,
      },
    });
    await db.galleryExample.create({
      data: {
        candidateId: hiddenCandidate.id,
        customBuildId: hidden.id,
        contributorId: ownerId,
        postAnonymously: true,
        removedAt: now,
      },
    });
    assert.equal(
      (await listAdminGenerations(adminId, { ownerId })).items.find((item) => item.id === hidden.publicId)?.canPublish,
      false,
    );
    await assert.rejects(
      () => publishAdminGeneration(adminId, hidden.publicId),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "generation_not_available",
    );

    console.log("Admin generation publish checks passed");
  } finally {
    await db.galleryModerationRecord.deleteMany({
      where: { OR: [{ actorUserId: { in: userIds } }, { subjectUserId: { in: userIds } }] },
    });
    await db.galleryCandidate.deleteMany({
      where: { OR: [{ uploaderId: { in: userIds } }, { promptText: { contains: suffix } }] },
    });
    await db.customBuild.deleteMany({ where: { ownerId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
