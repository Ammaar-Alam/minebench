import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("Gallery service checks require pnpm test:integration");
    return;
  }
  const db = new PrismaClient();
  const suffix = randomUUID().replace(/[^0-9]/g, "").slice(0, 8) || "12345678";
  const uploaderId = randomUUID();
  const visitorId = randomUUID();
  const adminId = randomUUID();
  const buildId = randomUUID();
  const buildPublicId = `cb_${suffix}saved`;
  const prompt = "A lantern-lit cliff observatory";
  const runAt = new Date("2026-08-31T04:35:00.000Z");
  const legacyPrompt = `A legacy-key Gallery prompt ${suffix}`;
  const racePrompt = `A selection and removal race ${suffix}`;
  const officialSeedPrompts = {
    [`official-seed-one-${suffix}`]: `Official Gallery seed one ${suffix}`,
    [`official-seed-two-${suffix}`]: `Official Gallery seed two ${suffix}`,
  };
  const {
    addGalleryExample,
    claimAnonymousGalleryVotes,
    GalleryServiceError,
    getGalleryCandidate,
    hideGalleryExample,
    listGalleryCandidates,
    removeGalleryCandidate,
    setGalleryCandidateSelected,
    setGalleryPublishingSuspension,
    setGalleryVote,
    submitGalleryAppeal,
    submitGalleryCandidate,
  } = await import("../../../lib/gallery/service");
  const { seedGalleryOfficialPrompts } = await import("../../../scripts/seed-gallery-official-prompts");

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
        {
          id: adminId,
          email: `gallery-admin-${suffix}@example.test`,
          publicNickname: `MineBench ${suffix}`,
          publicNicknameNormalized: `minebench ${suffix}`,
          isMineBenchAdmin: true,
        },
      ],
    });
    await db.customBuild.create({
      data: {
        id: buildId,
        publicId: buildPublicId,
        ownerId: uploaderId,
        status: "succeeded",
        currentStage: "complete",
        completedAt: runAt,
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
        generationTimeMs: 125_000,
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
            {
              kind: "preview_mbv4",
              format: "mbv4",
              bucket: "builds",
              path: `test/${suffix}/preview.mbv4`,
              contentType: "application/octet-stream",
              fileName: "preview.mbv4",
              sha256: "e".repeat(64),
              sourceBuildSha256: "b".repeat(64),
              byteSize: 80,
              storedByteSize: 80,
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
    assert.equal(created.candidate.cover?.blockCount, 4);
    assert.equal(created.candidate.cover?.jsonBytes, 100);
    assert.equal(created.candidate.cover?.generationTimeMs, 125_000);
    assert.equal(created.candidate.cover?.runAt, runAt.toISOString());
    assert.equal(created.candidate.cover?.buildId, buildPublicId);
    assert.equal(
      created.candidate.cover?.thumbnailUrl,
      `/api/gallery/examples/${created.candidate.cover?.id}/thumbnail`,
    );
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
    assert.equal(caseVariant.created, false);
    assert.equal(caseVariant.candidate.id, created.candidate.id);

    const navigationIds = {
      newest: `gal_${suffix}newest`,
      highest: `gal_${suffix}highest`,
      middle: `gal_${suffix}middle`,
      hidden: `gal_${suffix}hidden`,
    };
    await db.galleryCandidate.createMany({
      data: [
        {
          id: `nav_${suffix}_newest`,
          publicId: navigationIds.newest,
          promptText: `Newest navigation prompt ${suffix}`,
          promptKey: `navigation-newest-${suffix}`,
          uploaderId,
          upvoteCount: 1_000_100,
          publishedAt: new Date("2035-01-03T00:00:00.000Z"),
        },
        {
          id: `nav_${suffix}_highest`,
          publicId: navigationIds.highest,
          promptText: `Highest navigation prompt ${suffix}`,
          promptKey: `navigation-highest-${suffix}`,
          uploaderId,
          upvoteCount: 1_000_300,
          publishedAt: new Date("2035-01-02T00:00:00.000Z"),
        },
        {
          id: `nav_${suffix}_middle`,
          publicId: navigationIds.middle,
          promptText: `Middle navigation prompt ${suffix}`,
          promptKey: `navigation-middle-${suffix}`,
          uploaderId,
          upvoteCount: 1_000_200,
          publishedAt: new Date("2035-01-01T00:00:00.000Z"),
        },
        {
          id: `nav_${suffix}_hidden`,
          publicId: navigationIds.hidden,
          promptText: `Hidden navigation prompt ${suffix}`,
          promptKey: `navigation-hidden-${suffix}`,
          uploaderId,
          upvoteCount: 1_000_250,
          publishedAt: new Date("2035-01-01T12:00:00.000Z"),
          adminHiddenAt: new Date(),
        },
      ],
    });
    assert.deepEqual(
      (await getGalleryCandidate(navigationIds.highest, { navigationSort: "new" }))?.navigation,
      { sort: "new", previousId: navigationIds.newest, nextId: navigationIds.middle },
      "New navigation should follow visible publication order",
    );
    assert.deepEqual(
      (await getGalleryCandidate(navigationIds.middle, { navigationSort: "top" }))?.navigation,
      { sort: "top", previousId: navigationIds.highest, nextId: navigationIds.newest },
      "Top navigation should follow visible vote order",
    );
    await setGalleryCandidateSelected(adminId, navigationIds.middle, true);
    await setGalleryCandidateSelected(adminId, navigationIds.highest, true);
    await db.galleryCandidate.update({
      where: { publicId: navigationIds.middle },
      data: { selectedAt: new Date("2035-01-02T00:00:00.000Z") },
    });
    await db.galleryCandidate.update({
      where: { publicId: navigationIds.highest },
      data: { selectedAt: new Date("2035-01-03T00:00:00.000Z") },
    });
    const official = await listGalleryCandidates({ sort: "official", limit: 10 });
    assert.deepEqual(
      official.items.map((item) => item.id).filter((id) => Object.values(navigationIds).includes(id)),
      [navigationIds.highest, navigationIds.middle],
      "Official sorting should include only selected prompts in selection order",
    );
    assert.deepEqual(
      (await getGalleryCandidate(navigationIds.highest, { navigationSort: "official" }))?.navigation,
      { sort: "official", previousId: null, nextId: navigationIds.middle },
      "Official navigation should stay within selected prompts",
    );
    assert.equal(
      (await getGalleryCandidate(navigationIds.newest, { navigationSort: "official" }))?.navigation,
      null,
      "Non-official prompts should ignore official navigation",
    );
    await db.galleryCandidate.deleteMany({
      where: { publicId: { in: Object.values(navigationIds) } },
    });

    const firstSeed = await seedGalleryOfficialPrompts(adminId, officialSeedPrompts);
    assert.deepEqual(firstSeed.map((result) => result.status), ["created", "created"]);
    const repeatedSeed = await seedGalleryOfficialPrompts(adminId, officialSeedPrompts);
    assert.deepEqual(repeatedSeed.map((result) => result.status), ["already_official", "already_official"]);
    const seededIds = new Set(firstSeed.map((result) => result.candidateId));
    const seededCandidates = (await listGalleryCandidates({ sort: "official", limit: 10 })).items
      .filter((candidate) => seededIds.has(candidate.id));
    assert.equal(seededCandidates.length, 2);
    assert.equal(seededCandidates.every((candidate) => candidate.exampleCount === 0), true);

    const legacyCandidate = await db.galleryCandidate.create({
      data: {
        publicId: `gal_${suffix}legacy`,
        promptText: legacyPrompt,
        promptKey: createHash("sha256").update(legacyPrompt).digest("hex"),
        uploaderId,
        postAnonymously: true,
      },
    });
    const legacyDuplicate = await submitGalleryCandidate(uploaderId, {
      prompt: legacyPrompt,
      postAnonymously: true,
    });
    assert.equal(legacyDuplicate.created, false);
    assert.equal(legacyDuplicate.candidate.id, legacyCandidate.publicId);
    assert.equal(await db.galleryCandidate.count({ where: { promptText: legacyPrompt } }), 1);

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
      const model = index === 0
        ? { kind: "catalog", key: "gemini_3_7_flash", provider: "google", id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" }
        : index === 2
          ? { kind: "catalog", key: "openai_gpt_5_6_sol", provider: "openai", id: "gpt-5.6-sol", label: "GPT 5.6 Sol Pro" }
          : { kind: "custom", key: null, provider: "custom", id: `local-v1-${suffix}`, label: "Local Forge" };
      await db.customBuild.create({
        data: {
          id: extraId,
          publicId: extraPublicId,
          ownerId: uploaderId,
          status: "succeeded",
          currentStage: "complete",
          promptText: index === 0 ? prompt.toUpperCase() : prompt,
          promptSha256: `${index + 1}`.repeat(64),
          gridSize: 64,
          palette: "simple",
          modelKind: model.kind,
          modelKey: model.key,
          modelProvider: model.provider,
          modelId: model.id,
          modelDisplayName: model.label,
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
    assert.deepEqual(
      newest.items[0]?.modelLabels,
      ["GPT 5.4 Mini", "Gemini 3.7 Flash", `Custom · Local Forge · local-v1-${suffix}`, "GPT 5.6 Sol Pro"],
      "browse cards should expose distinct model labels in example order",
    );
    const hiddenModelSearch = await listGalleryCandidates({ sort: "top", limit: 10, query: "sol pro" });
    assert.equal(hiddenModelSearch.items[0]?.id, created.candidate.id, "search should include models beyond the card previews");
    assert.deepEqual(hiddenModelSearch.items[0]?.matchedModelLabels, ["GPT 5.6 Sol Pro"]);
    const customModelSearch = await listGalleryCandidates({ sort: "top", limit: 10, query: "custom" });
    assert.equal(customModelSearch.items[0]?.id, created.candidate.id, "search should include the displayed custom-model prefix");
    assert.deepEqual(customModelSearch.items[0]?.matchedModelLabels, [`Custom · Local Forge · local-v1-${suffix}`]);
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
    assert.deepEqual(deletedArtifacts, [
      `test/${suffix}/build.json.gz`,
      `test/${suffix}/preview.mbv4`,
    ]);
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
      setGalleryCandidateSelected(adminId, raceCandidate.candidate.id, true),
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
      setGalleryCandidateSelected(adminId, created.candidate.id, true),
      setGalleryCandidateSelected(adminId, created.candidate.id, true),
    ]);
    assert.equal(selections[0]?.promptId, selections[1]?.promptId);
    assert.equal(await db.galleryModerationRecord.count({
      where: { candidate: { publicId: created.candidate.id }, action: "selected" },
    }), 1);
    await setGalleryCandidateSelected(adminId, created.candidate.id, false);
    await setGalleryCandidateSelected(adminId, created.candidate.id, false);
    assert.equal(await db.galleryModerationRecord.count({
      where: { candidate: { publicId: created.candidate.id }, action: "unselected" },
    }), 1);
    await setGalleryCandidateSelected(adminId, created.candidate.id, true);
    assert.equal(
      (await getGalleryCandidate(created.candidate.id, { userId: uploaderId }))?.canRemove,
      false,
    );
    await setGalleryPublishingSuspension(adminId, uploaderId, {
      suspended: true,
      reason: "Review in progress",
    });
    const appealResults = await Promise.allSettled(
      Array.from({ length: 8 }, () => submitGalleryAppeal(uploaderId, "Please review this suspension.")),
    );
    assert.equal(
      appealResults.filter((result) => result.status === "fulfilled").length,
      1,
      "concurrent appeals must admit only one request per account",
    );
    assert.equal(
      appealResults.filter((result) => result.status === "rejected").every((result) =>
        result.reason instanceof GalleryServiceError && result.reason.code === "appeal_rate_limited"
      ),
      true,
    );
    assert.equal(await db.galleryModerationRecord.count({
      where: { kind: "APPEAL", subjectUserId: uploaderId },
    }), 1);
    const visible = await listGalleryCandidates({ sort: "new", limit: 10 });
    assert.equal(visible.items.some((item) => item.id === created.candidate.id), true);

    await assert.rejects(
      () => removeGalleryCandidate(uploaderId, created.candidate.id),
      (error: unknown) =>
        error instanceof GalleryServiceError && error.code === "selected_candidate",
    );
    await setGalleryPublishingSuspension(adminId, uploaderId, { suspended: false });
    await setGalleryPublishingSuspension(adminId, uploaderId, { suspended: true });
    await submitGalleryAppeal(uploaderId, "Please review this new suspension.");
    assert.equal(await db.galleryModerationRecord.count({
      where: { kind: "APPEAL", subjectUserId: uploaderId },
    }), 2, "restoring an account must reset its appeal cooldown");
    await setGalleryPublishingSuspension(adminId, uploaderId, { suspended: false });
    const removable = await submitGalleryCandidate(uploaderId, {
      prompt: `A removable Gallery prompt ${suffix}`,
      postAnonymously: true,
    });
    await removeGalleryCandidate(uploaderId, removable.candidate.id);
    assert.equal(
      (await listGalleryCandidates({ sort: "new", limit: 10 })).items.some(
        (item) => item.id === removable.candidate.id,
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
    await db.galleryCandidate.deleteMany({ where: { uploaderId: { in: [uploaderId, adminId] } } });
    await db.prompt.deleteMany({
      where: { text: { in: [prompt, legacyPrompt, racePrompt, ...Object.values(officialSeedPrompts)] } },
    });
    await db.customBuild.deleteMany({ where: { ownerId: uploaderId } });
    await db.user.deleteMany({ where: { id: { in: [uploaderId, visitorId, adminId] } } });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
