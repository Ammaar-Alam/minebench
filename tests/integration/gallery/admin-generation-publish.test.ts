import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type CustomBuildStatus } from "@prisma/client";
import { sha256Hex } from "../../../lib/custom-builds/hash";
import { voxelWorldPartSourceSha256 } from "../../../lib/custom-builds/worldArtifacts";

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
  const previousEncryptionSecret = process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET;
  process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = "admin-publish-test-encryption-secret";

  const {
    addGalleryExample,
    getGalleryCandidate,
    GalleryServiceError,
    removeGalleryExample,
    submitGalleryCandidate,
  } = await import("../../../lib/gallery/service");
  const {
    createSavedGenerations,
    getAdminGenerationArtifact,
    listAdminGenerations,
    publishAdminGeneration,
    removeSavedGeneration,
    retrySavedGeneration,
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
        promptText: `Admin publish prompt ${label}`,
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

    for (const gridSize of [2048, 8192] as const) {
      const input = {
        ownerId, prompt: "A large observatory", gridSize, palette: "simple" as const,
        models: [{ id: "large", kind: "catalog" as const, modelKey: "openai_gpt_5_4_mini" as const }],
        providerKeys: { openai: "request-only-test-secret" },
      };
      await assert.rejects(() => createSavedGenerations(input), (error: unknown) =>
        error instanceof GalleryServiceError && error.code === "forbidden");
      assert.equal(await db.customBuild.count({ where: { ownerId } }), 0);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).totalGenerationCount, 0);
      const [large] = await createSavedGenerations({ ...input, ownerId: adminId });
      assert.equal(large!.gridSize, gridSize);
      await db.customBuild.update({
        where: { publicId: large!.id }, data: { status: "failed", errorRetryable: true, errorCode: "provider_error" },
      });
      await db.user.update({ where: { id: adminId }, data: { isMineBenchAdmin: false } });
      await assert.rejects(() => retrySavedGeneration(adminId, large!.id, { providerKey: "retry-test-secret" }),
        (error: unknown) => error instanceof GalleryServiceError && error.code === "forbidden");
      assert.equal((await db.customBuild.findUniqueOrThrow({ where: { publicId: large!.id } })).status, "failed");
      await db.user.update({ where: { id: adminId }, data: { isMineBenchAdmin: true } });
      assert.equal((await retrySavedGeneration(adminId, large!.id, { providerKey: "retry-test-secret" })).status, "queued");
    }

    const importedIds: string[] = [];
    for (const label of ["first_import", "second_import"]) {
      const imported = await createBuild(label);
      await db.customBuild.update({
        where: { id: imported.id },
        data: { generationMode: "import", modelKind: "import", promptText: "Imported build" },
      });
      importedIds.push(imported.publicId);
      await assert.rejects(
        () => submitGalleryCandidate(ownerId, { generationId: imported.publicId, postAnonymously: true }),
        (error: unknown) => error instanceof GalleryServiceError && error.code === "generation_not_available",
      );
      await assert.rejects(
        () => publishAdminGeneration(adminId, imported.publicId),
        (error: unknown) => error instanceof GalleryServiceError && error.code === "invalid_prompt",
      );
      assert.equal(
        (await listAdminGenerations(adminId, { ownerId })).items.find((item) => item.id === imported.publicId)?.canPublish,
        true,
      );
    }
    assert.equal(await db.galleryCandidate.count({ where: { promptText: "Imported build" } }), 0);
    const importCandidate = await submitGalleryCandidate(ownerId, { prompt: "Imported build", postAnonymously: true });
    for (const generationId of importedIds) {
      await assert.rejects(
        () => addGalleryExample(ownerId, importCandidate.candidate.id, { generationId, postAnonymously: true }),
        (error: unknown) => error instanceof GalleryServiceError && error.code === "generation_mismatch",
      );
      await assert.rejects(
        () => addGalleryExample(ownerId, importCandidate.candidate.id, { generationId, postAnonymously: true }, { adminId: nonAdminId, prompt: "Imported build" }),
        (error: unknown) => error instanceof GalleryServiceError && error.code === "forbidden",
      );
    }
    assert.equal(await db.galleryExample.count({ where: { candidate: { publicId: importCandidate.candidate.id } } }), 0);
    await db.galleryCandidate.delete({ where: { publicId: importCandidate.candidate.id } });

    for (const prompt of ["Imported build", "  IMPORTED   BUILD  ", "x".repeat(801)]) {
      await assert.rejects(() => publishAdminGeneration(adminId, importedIds[0]!, prompt),
        (error: unknown) => error instanceof GalleryServiceError && error.code === "invalid_prompt");
    }
    const importedPublications = [];
    for (const [index, publicId] of importedIds.entries()) {
      const prompt = `A curated imported observatory ${index} ${suffix}`;
      const published = await publishAdminGeneration(adminId, publicId, prompt);
      importedPublications.push(published);
      const row = await db.customBuild.findUniqueOrThrow({ where: { publicId } });
      assert.equal(row.generationMode, "import");
      assert.equal(row.modelKind, "import");
      assert.equal(row.promptText, prompt);
      assert.equal(row.promptSha256, sha256Hex(prompt));
      const candidate = await getGalleryCandidate(published.candidateId);
      assert.deepEqual(candidate?.cover?.model, { kind: "custom", label: "Imported build" });
      assert.deepEqual(await publishAdminGeneration(adminId, publicId, "A changed description"), { ...published, created: false });
      assert.equal((await db.customBuild.findUniqueOrThrow({ where: { publicId } })).promptText, prompt);
    }
    assert.notEqual(importedPublications[0]!.candidateId, importedPublications[1]!.candidateId);
    const matchingImport = await createBuild("matching_import");
    await db.customBuild.update({
      where: { id: matchingImport.id }, data: { generationMode: "import", modelKind: "import", promptText: "Imported build" },
    });
    const matching = await publishAdminGeneration(adminId, matchingImport.publicId, `A CURATED imported observatory 1 ${suffix}`);
    assert.equal(matching.candidateId, importedPublications[1]!.candidateId);
    assert.equal((await getGalleryCandidate(matching.candidateId))?.exampleCount, 2);
    const matchingRow = await db.customBuild.findUniqueOrThrow({ where: { id: matchingImport.id } });
    assert.equal(matchingRow.promptText, `A curated imported observatory 1 ${suffix}`);
    assert.equal(matchingRow.promptSha256, sha256Hex(matchingRow.promptText));
    const concurrentImport = await createBuild("concurrent_import");
    await db.customBuild.update({
      where: { id: concurrentImport.id }, data: { generationMode: "import", modelKind: "import", promptText: "Imported build" },
    });
    const publications = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      publishAdminGeneration(adminId, concurrentImport.publicId, `Concurrent imported landscape ${index} ${suffix}`)));
    assert.ok(publications.some((result) => result.status === "fulfilled" && result.value.created));
    for (const result of publications) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof GalleryServiceError && result.reason.code === "generation_not_available");
      }
    }
    const concurrent = await db.customBuild.findUniqueOrThrow({
      where: { id: concurrentImport.id }, include: { galleryExamples: { include: { candidate: true } } },
    });
    assert.equal(concurrent.galleryExamples.length, 1, "concurrent publication must attach an import to only one prompt");
    assert.equal(concurrent.promptText, concurrent.galleryExamples[0]!.candidate.promptText);
    assert.equal(concurrent.promptSha256, sha256Hex(concurrent.promptText));
    const importedPublicId = importedIds[0]!;
    const sourceBuildSha256 = "b".repeat(64);
    await db.customBuildArtifact.updateMany({
      where: { customBuild: { publicId: importedPublicId }, kind: "viewer_mbv4" },
      data: { kind: "viewer_world", format: "json", contentType: "application/json" },
    });
    const importedBuild = await db.customBuild.findUniqueOrThrow({ where: { publicId: importedPublicId } });
    await db.customBuildArtifact.createMany({ data: ["preview_svg", "preview_mbv4"].map((kind) => ({
      customBuildId: importedBuild.id, kind: kind as "preview_svg" | "preview_mbv4", format: kind,
      bucket: "builds", path: `admin-publish/${suffix}/${kind}`, contentType: "application/octet-stream",
      fileName: kind, sha256: "f".repeat(64), byteSize: 60, storedByteSize: 60,
    })) });
    const worldCandidate = await getGalleryCandidate(importedPublications[0]!.candidateId);
    for (const example of [worldCandidate?.cover, ...worldCandidate!.examples]) {
      assert.ok(example);
      assert.equal(example.viewerUrl, null, "legacy clients must not receive spatial viewer URLs");
      assert.equal(example.thumbnailUrl, null, "world preview coordinates may exceed native packing limits");
      assert.ok(example.previewUrl, "legacy clients retain their PNG image preview");
      assert.equal(example.worldViewerUrl, `/api/gallery/examples/${example.id}/viewer?format=world`);
    }
    await db.customBuildArtifact.create({
      data: {
        customBuild: { connect: { publicId: importedPublicId } }, kind: "world_part", format: "mbv4", bucket: "builds",
        path: `admin-publish/${suffix}/part.mbv4`, contentType: "application/octet-stream", fileName: "part.mbv4",
        sha256: "e".repeat(64), sourceBuildSha256: voxelWorldPartSourceSha256(sourceBuildSha256, "region-0"),
        byteSize: 60, storedByteSize: 60,
      },
    });
    assert.equal((await getAdminGenerationArtifact(adminId, importedPublicId, ["viewer_world"]))?.sourceBuildSha256, sourceBuildSha256);
    assert.ok(await getAdminGenerationArtifact(adminId, importedPublicId, ["world_part"], { sourceBuildSha256, partKey: "region-0" }));
    assert.equal(await getAdminGenerationArtifact(adminId, importedPublicId, ["world_part"], { sourceBuildSha256, partKey: "another-region" }), null);
    await assert.rejects(() => getAdminGenerationArtifact(nonAdminId, importedPublicId, ["viewer_world"]),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "forbidden");
    await removeSavedGeneration(ownerId, importedPublicId, { acknowledgePublicExamples: true });
    assert.equal(await getAdminGenerationArtifact(adminId, importedPublicId, ["viewer_world"]), null);
    assert.equal(await getAdminGenerationArtifact(adminId, importedPublicId, ["world_part"], { sourceBuildSha256, partKey: "region-0" }), null);
    assert.equal((await getGalleryCandidate(importedPublications[0]!.candidateId))?.exampleCount, 0);

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
      where: { action: "generation_published", actorUserId: adminId, subjectUserId: ownerId, exampleId: published.exampleId },
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
      () => removeSavedGeneration(ownerId, removableBuild.publicId),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "public_examples_require_confirmation",
    );
    assert.deepEqual(
      await removeSavedGeneration(ownerId, removableBuild.publicId, {
        acknowledgePublicExamples: true,
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
    if (previousEncryptionSecret === undefined) delete process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET;
    else process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = previousEncryptionSecret;
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
