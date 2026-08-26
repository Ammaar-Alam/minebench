import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("Gallery service checks require pnpm test:integration");
    return;
  }
  const db = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const uploaderId = randomUUID();
  const visitorId = randomUUID();
  const adminId = randomUUID();
  const buildId = randomUUID();
  const buildPublicId = `cb_${suffix}saved`;
  const prompt = "A lantern-lit cliff observatory";
  const racePrompt = `A selection and removal race ${suffix}`;
  const {
    addGalleryExample,
    claimAnonymousGalleryVotes,
    GalleryServiceError,
    getGalleryCandidate,
    hideGalleryExample,
    listGalleryCandidates,
    removeGalleryCandidate,
    selectGalleryCandidate,
    setGalleryPublishingSuspension,
    setGalleryVote,
    submitGalleryCandidate,
  } = await import("../../../lib/gallery/service");

  try {
    await db.user.createMany({
      data: [
        {
          id: uploaderId,
          email: `gallery-uploader-${suffix}@example.test`,
          publicNickname: "Cliff Builder",
          publicNicknameNormalized: "cliff builder",
        },
        { id: visitorId, email: `gallery-visitor-${suffix}@example.test` },
        { id: adminId, email: `gallery-admin-${suffix}@example.test`, isMineBenchAdmin: true },
      ],
    });
    await db.customBuild.create({
      data: {
        id: buildId,
        publicId: buildPublicId,
        ownerId: uploaderId,
        status: "succeeded",
        currentStage: "complete",
        promptText: prompt,
        promptSha256: "a".repeat(64),
        gridSize: 64,
        palette: "simple",
        modelKind: "catalog",
        modelKey: "openai_gpt_5_4_mini",
        modelProvider: "openai",
        modelId: "gpt-5.4-mini",
        modelDisplayName: "GPT 5.4 Mini",
        blockCount: 4,
        buildSha256: "b".repeat(64),
        buildByteSize: 100,
        buildCompressedByteSize: 60,
        storedByteSize: 120,
        artifacts: {
          create: [
            {
              kind: "build_json",
              format: "json.gz",
              bucket: "builds",
              path: `test/${suffix}/build.json.gz`,
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
              kind: "preview_svg",
              format: "svg",
              bucket: "builds",
              path: `test/${suffix}/preview.svg`,
              contentType: "image/svg+xml",
              fileName: "preview.svg",
              sha256: "d".repeat(64),
              sourceBuildSha256: "b".repeat(64),
              byteSize: 60,
              storedByteSize: 60,
            },
          ],
        },
      },
    });

    const created = await submitGalleryCandidate(uploaderId, {
      generationId: buildPublicId,
      postAnonymously: false,
    });
    assert.equal(created.created, true);
    assert.equal(created.candidate.prompt, prompt);
    assert.equal(created.candidate.attribution, "Cliff Builder");
    assert.equal(created.candidate.exampleCount, 1);
    assert.equal(
      (await getGalleryCandidate(created.candidate.id, { userId: uploaderId }))?.canRemove,
      true,
    );

    const duplicate = await submitGalleryCandidate(uploaderId, {
      prompt: `  ${prompt}  `,
      postAnonymously: true,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.candidate.id, created.candidate.id);
    assert.equal(duplicate.candidate.exampleCount, 1);

    const caseVariant = await submitGalleryCandidate(uploaderId, {
      prompt: prompt.toUpperCase(),
      postAnonymously: true,
    });
    assert.equal(caseVariant.created, true);

    const updatedExample = await addGalleryExample(uploaderId, created.candidate.id, {
      generationId: buildPublicId,
      postAnonymously: true,
    });
    assert.equal(updatedExample.created, false);
    const updatedCandidate = await getGalleryCandidate(created.candidate.id);
    assert.equal(updatedCandidate?.exampleCount, 1, "an attribution update must not duplicate the build");
    assert.equal(updatedCandidate?.cover?.attribution, "Anonymous");
    assert.equal(updatedCandidate?.publishedAt, created.candidate.publishedAt, "an attribution update must not refresh New order");

    for (let index = 0; index < 3; index += 1) {
      const extraId = randomUUID();
      const extraPublicId = `cb_${suffix}extra${index}`;
      await db.customBuild.create({
        data: {
          id: extraId,
          publicId: extraPublicId,
          ownerId: uploaderId,
          status: "succeeded",
          currentStage: "complete",
          promptText: prompt,
          promptSha256: `${index + 1}`.repeat(64),
          gridSize: 64,
          palette: "simple",
          modelKind: "catalog",
          modelProvider: "openai",
          modelId: "gpt-5.4-mini",
          modelDisplayName: "GPT 5.4 Mini",
          storedByteSize: 10,
          artifacts: {
            create: {
              kind: "build_json",
              format: "json.gz",
              bucket: "builds",
              path: `test/${suffix}/extra-${index}.json.gz`,
              encoding: "gzip",
              contentType: "application/json",
              fileName: "build.json",
              sha256: `${index + 4}`.repeat(64),
              byteSize: 20,
              compressedByteSize: 10,
              storedByteSize: 10,
            },
          },
        },
      });
      await addGalleryExample(uploaderId, created.candidate.id, {
        generationId: extraPublicId,
        postAnonymously: false,
      });
    }
    const newest = await listGalleryCandidates({ sort: "new", limit: 10 });
    assert.equal(newest.items[0]?.id, created.candidate.id, "a new example should refresh New order");
    assert.equal(newest.items[0]?.cover?.id, created.candidate.cover?.id, "the original cover should stay fixed");
    assert.ok(newest.items[0]?.alternate, "browse cards should include another visible example");
    const firstExamples = await getGalleryCandidate(created.candidate.id, { examplesLimit: 2 });
    assert.equal(firstExamples?.exampleCount, 4);
    assert.equal(firstExamples?.examples.length, 3, "the fixed cover should precede the first page");
    assert.ok(firstExamples?.nextExamplesCursor);
    const laterExamples = await getGalleryCandidate(created.candidate.id, {
      examplesLimit: 2,
      examplesCursor: firstExamples?.nextExamplesCursor,
    });
    assert.equal(laterExamples?.examples.length, 1);
    assert.equal(laterExamples?.examples.some((example) => example.id === firstExamples?.cover?.id), false);
    assert.equal(laterExamples?.nextExamplesCursor, null);
    const deletedArtifacts: string[] = [];
    await hideGalleryExample(adminId, firstExamples!.cover!.id, async ({ path }) => {
      deletedArtifacts.push(path);
    });
    assert.deepEqual(deletedArtifacts, [`test/${suffix}/build.json.gz`]);
    assert.equal(await db.customBuildArtifact.count({
      where: { customBuildId: buildId, kind: "preview_svg" },
    }), 1);
    assert.equal((await db.customBuild.findUniqueOrThrow({ where: { id: buildId } })).removedAt instanceof Date, true);
    assert.notEqual((await getGalleryCandidate(created.candidate.id))?.cover?.id, firstExamples?.cover?.id);

    const firstVote = await setGalleryVote({
      publicId: created.candidate.id,
      sessionId: `session-${suffix}`,
      userId: null,
      upvoted: true,
    });
    assert.deepEqual(firstVote, { upvoted: true, count: 1 });
    assert.deepEqual(
      await setGalleryVote({
        publicId: created.candidate.id,
        sessionId: `session-${suffix}`,
        userId: null,
        upvoted: true,
      }),
      { upvoted: true, count: 1 },
    );
    assert.equal(await claimAnonymousGalleryVotes(visitorId, `session-${suffix}`), 1);
    const accountVote = await setGalleryVote({
      publicId: created.candidate.id,
      sessionId: `signed-in-${suffix}`,
      userId: visitorId,
      upvoted: true,
    });
    assert.deepEqual(accountVote, { upvoted: true, count: 1 });
    assert.equal(
      (await listGalleryCandidates({ sort: "top", limit: 10, userId: visitorId })).items[0]?.upvoted,
      true,
    );
    assert.deepEqual(await setGalleryVote({
      publicId: created.candidate.id,
      sessionId: `another-session-${suffix}`,
      userId: visitorId,
      upvoted: false,
    }), { upvoted: false, count: 0 });
    await setGalleryVote({
      publicId: created.candidate.id,
      sessionId: `another-session-${suffix}`,
      userId: visitorId,
      upvoted: true,
    });
    assert.equal((await listGalleryCandidates({ sort: "top", limit: 10 })).items[0]?.upvoteCount, 1);

    const raceCandidate = await submitGalleryCandidate(uploaderId, {
      prompt: racePrompt,
      postAnonymously: true,
    });
    const raceResults = await Promise.allSettled([
      selectGalleryCandidate(adminId, raceCandidate.candidate.id),
      removeGalleryCandidate(uploaderId, raceCandidate.candidate.id),
    ]);
    assert.equal(
      raceResults.filter((result) => result.status === "fulfilled").length,
      1,
      "selection and owner removal must not both commit",
    );
    const racedRow = await db.galleryCandidate.findUniqueOrThrow({
      where: { publicId: raceCandidate.candidate.id },
      select: { selectedAt: true, removedAt: true },
    });
    assert.notEqual(Boolean(racedRow.selectedAt), Boolean(racedRow.removedAt));

    const selections = await Promise.all([
      selectGalleryCandidate(adminId, created.candidate.id),
      selectGalleryCandidate(adminId, created.candidate.id),
    ]);
    assert.equal(selections[0]?.promptId, selections[1]?.promptId);
    assert.equal(await db.galleryModerationRecord.count({
      where: { candidate: { publicId: created.candidate.id }, action: "selected" },
    }), 1);
    assert.equal(
      (await getGalleryCandidate(created.candidate.id, { userId: uploaderId }))?.canRemove,
      false,
    );
    await setGalleryPublishingSuspension(adminId, uploaderId, {
      suspended: true,
      reason: "Review in progress",
    });
    const visible = await listGalleryCandidates({ sort: "new", limit: 10 });
    assert.equal(visible.items.some((item) => item.id === created.candidate.id), true);
    assert.equal(visible.items.some((item) => item.id === caseVariant.candidate.id), false);

    await assert.rejects(
      () => removeGalleryCandidate(uploaderId, created.candidate.id),
      (error: unknown) =>
        error instanceof GalleryServiceError && error.code === "selected_candidate",
    );
    await setGalleryPublishingSuspension(adminId, uploaderId, { suspended: false });
    await removeGalleryCandidate(uploaderId, caseVariant.candidate.id);
    assert.equal(
      (await listGalleryCandidates({ sort: "new", limit: 10 })).items.some(
        (item) => item.id === caseVariant.candidate.id,
      ),
      false,
    );

    const { POST: reportRoute } = await import("../../../app/api/gallery/reports/route");
    const missingReport = await reportRoute(new Request("http://localhost/api/gallery/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: "missing-candidate", reason: "SPAM" }),
    }));
    assert.equal(missingReport.status, 200);
    assert.deepEqual(await missingReport.json(), { submitted: true });

    console.log("Gallery application-service checks passed");
  } finally {
    await db.galleryCandidate.deleteMany({ where: { uploaderId } });
    await db.prompt.deleteMany({ where: { text: { in: [prompt, racePrompt] } } });
    await db.customBuild.deleteMany({ where: { ownerId: uploaderId } });
    await db.user.deleteMany({ where: { id: { in: [uploaderId, visitorId, adminId] } } });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
