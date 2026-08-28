import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("Gallery generation checks require pnpm test:integration");
    return;
  }
  process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = "gallery-test-encryption-secret";
  const previousHostedKey = process.env.MINEBENCH_FREE_OPENROUTER_API_KEY;
  process.env.MINEBENCH_FREE_OPENROUTER_API_KEY = "hosted-openrouter-secret";
  const db = new PrismaClient();
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const suffix = randomUUID().slice(0, 8);

  const {
    cancelSavedGeneration,
    createSavedGenerations,
    GenerationServiceError,
    getSavedGeneration,
    listSavedGenerations,
    removeSavedGeneration,
    retrySavedGeneration,
  } = await import("../../../lib/generations/service");

  try {
    await db.user.createMany({
      data: [
        { id: ownerId, email: `gallery-owner-${suffix}@example.test` },
        { id: otherId, email: `gallery-other-${suffix}@example.test` },
      ],
    });

    const created = await createSavedGenerations({
      ownerId,
      prompt: "A tiny observatory",
      gridSize: 64,
      palette: "simple",
      models: [
        { id: "one", kind: "catalog", modelKey: "openai_gpt_5_4_mini" },
        { id: "two", kind: "catalog", modelKey: "openai_gpt_5_4_mini" },
      ],
      providerKeys: { openai: "request-only-secret" },
    });
    assert.equal(created.length, 2);
    assert.notEqual(created[0]?.id, created[1]?.id);

    const rows = await db.customBuild.findMany({
      where: { ownerId },
      include: { jobs: true, secret: true },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => row.jobs.length === 1), true);
    assert.equal(rows.every((row) => row.jobs[0]?.maxAttempts === 2), true);
    assert.equal(rows.every((row) => row.secret?.keyCiphertext !== "request-only-secret"), true);
    assert.notEqual(rows[0]?.secret?.keyCiphertext, rows[1]?.secret?.keyCiphertext);
    assert.equal(rows.every((row) => !row.usesHostedGeneration), true);
    assert.deepEqual(
      await db.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: { totalGenerationCount: true, hostedGenerationCount: true },
      }),
      { totalGenerationCount: 2, hostedGenerationCount: 0 },
    );

    assert.equal(await getSavedGeneration(otherId, created[0]!.id), null);
    assert.equal((await getSavedGeneration(ownerId, created[0]!.id))?.prompt, "A tiny observatory");
    assert.equal((await listSavedGenerations(ownerId, { limit: 10 })).items.length, 2);

    const hosted = await createSavedGenerations({
      ownerId,
      prompt: "A hosted observatory",
      gridSize: 64,
      palette: "simple",
      models: [{ id: "hosted", kind: "catalog", modelKey: "gemini_3_7_flash" }],
      providerKeys: {},
    });
    const hostedRow = await db.customBuild.findUniqueOrThrow({
      where: { publicId: hosted[0]!.id },
      include: { secret: true },
    });
    assert.equal(hostedRow.usesHostedGeneration, true);
    assert.equal(hostedRow.preferOpenRouter, true);
    assert.equal(hostedRow.openRouterModelId, "google/gemini-3.7-flash");
    assert.equal(hostedRow.secret?.provider, "openrouter");
    assert.notEqual(hostedRow.secret?.keyCiphertext, "hosted-openrouter-secret");
    assert.deepEqual(
      await db.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: { totalGenerationCount: true, hostedGenerationCount: true },
      }),
      { totalGenerationCount: 3, hostedGenerationCount: 1 },
    );

    const routedWithUserKey = await createSavedGenerations({
      ownerId,
      prompt: "A user-funded observatory",
      gridSize: 64,
      palette: "simple",
      models: [{ id: "user-funded", kind: "catalog", modelKey: "gemini_3_7_flash" }],
      providerKeys: { openrouter: "user-openrouter-secret" },
    });
    assert.equal(
      (await db.customBuild.findUniqueOrThrow({ where: { publicId: routedWithUserKey[0]!.id } })).usesHostedGeneration,
      false,
    );
    assert.deepEqual(
      await db.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: { totalGenerationCount: true, hostedGenerationCount: true },
      }),
      { totalGenerationCount: 4, hostedGenerationCount: 1 },
    );

    await assert.rejects(
      () => createSavedGenerations({
        ownerId,
        prompt: "An ineligible hosted model",
        gridSize: 64,
        palette: "simple",
        models: [{ id: "ineligible", kind: "catalog", modelKey: "openai_gpt_5_4_mini" }],
        providerKeys: {},
      }),
      (error: unknown) => error instanceof GenerationServiceError && error.code === "missing_provider_key",
    );

    await db.user.update({
      where: { id: otherId },
      data: { hostedGenerationCount: 99, hostedGenerationLimit: 100 },
    });
    const concurrent = await Promise.allSettled([
      createSavedGenerations({
        ownerId: otherId,
        prompt: "First concurrent hosted build",
        gridSize: 64,
        palette: "simple",
        models: [{ id: "concurrent-one", kind: "catalog", modelKey: "gemini_3_7_flash" }],
        providerKeys: {},
      }),
      createSavedGenerations({
        ownerId: otherId,
        prompt: "Second concurrent hosted build",
        gridSize: 64,
        palette: "simple",
        models: [{ id: "concurrent-two", kind: "catalog", modelKey: "gemini_3_7_flash" }],
        providerKeys: {},
      }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
    assert.equal(
      concurrent.some((result) =>
        result.status === "rejected" &&
        result.reason instanceof GenerationServiceError &&
        result.reason.code === "hosted_generation_limit_reached"
      ),
      true,
    );
    assert.deepEqual(
      await db.user.findUniqueOrThrow({
        where: { id: otherId },
        select: { totalGenerationCount: true, hostedGenerationCount: true },
      }),
      { totalGenerationCount: 1, hostedGenerationCount: 100 },
    );
    assert.equal(await db.customBuild.count({ where: { ownerId: otherId, usesHostedGeneration: true } }), 1);

    const byokAtLimit = await createSavedGenerations({
      ownerId: otherId,
      prompt: "A build after the hosted limit",
      gridSize: 64,
      palette: "simple",
      models: [{ id: "byok-at-limit", kind: "catalog", modelKey: "gemini_3_7_flash" }],
      providerKeys: { gemini: "user-gemini-secret" },
    });
    assert.equal(
      (await db.customBuild.findUniqueOrThrow({ where: { publicId: byokAtLimit[0]!.id } })).usesHostedGeneration,
      false,
    );
    assert.deepEqual(
      await db.user.findUniqueOrThrow({
        where: { id: otherId },
        select: { totalGenerationCount: true, hostedGenerationCount: true },
      }),
      { totalGenerationCount: 2, hostedGenerationCount: 100 },
    );

    await db.customBuild.update({
      where: { id: hostedRow.id },
      data: {
        status: "failed",
        currentStage: "failed",
        completedAt: new Date(),
        errorCode: "generation_failed",
        errorMessage: "No valid build was returned.",
        errorRetryable: true,
      },
    });
    await db.customBuildJob.updateMany({
      where: { customBuildId: hostedRow.id },
      data: { status: "failed", completedAt: new Date() },
    });
    await db.customBuildSecret.deleteMany({ where: { customBuildId: hostedRow.id } });
    assert.equal((await retrySavedGeneration(ownerId, hosted[0]!.id, {})).status, "queued");
    const hostedRetrySecret = await db.customBuildSecret.findUniqueOrThrow({
      where: { customBuildId: hostedRow.id },
    });
    assert.equal(hostedRetrySecret.provider, "openrouter");
    assert.notEqual(hostedRetrySecret.keyCiphertext, "hosted-openrouter-secret");
    assert.deepEqual(
      await db.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: { totalGenerationCount: true, hostedGenerationCount: true },
      }),
      { totalGenerationCount: 4, hostedGenerationCount: 1 },
      "retrying an existing hosted build must not consume another allowance",
    );

    await db.customBuild.update({
      where: { id: rows[0]!.id },
      data: {
        status: "failed",
        currentStage: "failed",
        completedAt: new Date(),
        errorCode: "generation_failed",
        errorMessage: "No valid build was returned.",
        errorRetryable: true,
        progress: { attempt: 2, reason: 'Gemini error 400: {"private":"provider body"}' },
      },
    });
    assert.equal(
      (await getSavedGeneration(ownerId, created[0]!.id))?.retryReason,
      'Gemini error 400: {"private":"provider body"}',
      "legacy retry details must be categorized before returning to the browser",
    );
    await db.customBuildJob.updateMany({
      where: { customBuildId: rows[0]!.id },
      data: { status: "failed", completedAt: new Date() },
    });
    await db.customBuildSecret.deleteMany({ where: { customBuildId: rows[0]!.id } });
    const retried = await retrySavedGeneration(ownerId, created[0]!.id, {
      providerKey: "fresh-request-only-secret",
    });
    assert.equal(retried.status, "queued");
    assert.equal(retried.retryReason, null);
    const retrySecret = await db.customBuildSecret.findUnique({ where: { customBuildId: rows[0]!.id } });
    assert.ok(retrySecret);
    assert.notEqual(retrySecret.keyCiphertext, "fresh-request-only-secret");
    const retriedJobs = await db.customBuildJob.findMany({ where: { customBuildId: rows[0]!.id } });
    assert.equal(retriedJobs.length, 2);
    assert.equal(retriedJobs.at(-1)?.maxAttempts, 2);
    await assert.rejects(
      () => retrySavedGeneration(ownerId, created[0]!.id, { providerKey: "unused-secret" }),
      (error: unknown) => error instanceof GenerationServiceError && error.code === "not_retryable",
    );

    await db.customBuildArtifact.create({
      data: {
        customBuildId: rows[1]!.id,
        kind: "preview_svg",
        format: "svg",
        bucket: "builds",
        path: `gallery/${suffix}/cancel-race.svg`,
        contentType: "image/svg+xml",
        fileName: "preview.svg",
        sha256: "c".repeat(64),
        sourceBuildSha256: "d".repeat(64),
        byteSize: 10,
        storedByteSize: 10,
      },
    });
    const canceled = await cancelSavedGeneration(ownerId, created[1]!.id);
    assert.equal(canceled.status, "canceled");
    assert.equal(
      await db.customBuildSecret.count({ where: { customBuildId: rows[1]!.id } }),
      0,
    );
    assert.ok(
      (await db.customBuild.findUniqueOrThrow({ where: { id: rows[1]!.id } })).deletionPendingAt,
      "canceling a generation with recorded artifacts should schedule their cleanup",
    );

    const removable = await createSavedGenerations({
      ownerId,
      prompt: "A removable observatory",
      gridSize: 64,
      palette: "simple",
      models: [{ id: "removable", kind: "catalog", modelKey: "openai_gpt_5_4_mini" }],
      providerKeys: { openai: "request-only-secret" },
    });
    const removableRow = await db.customBuild.findUniqueOrThrow({
      where: { publicId: removable[0]!.id },
    });
    await db.customBuildArtifact.create({
      data: {
        customBuildId: removableRow.id,
        kind: "preview_svg",
        format: "svg",
        bucket: "builds",
        path: `gallery/${suffix}/remove-retry.svg`,
        contentType: "image/svg+xml",
        fileName: "preview.svg",
        sha256: "e".repeat(64),
        byteSize: 10,
        storedByteSize: 10,
      },
    });
    assert.deepEqual(
      await removeSavedGeneration(ownerId, removable[0]!.id, {
        deleteArtifact: async () => {
          throw new Error("storage unavailable");
        },
      }),
      { removed: true, publicExamplesRemoved: 0 },
    );
    const removed = await db.customBuild.findUniqueOrThrow({
      where: { publicId: removable[0]!.id },
      include: { jobs: true, secret: true },
    });
    assert.equal(removed.status, "canceled");
    assert.ok(removed.removedAt);
    assert.ok(removed.deletionPendingAt);
    assert.equal(removed.secret, null);
    assert.equal(removed.jobs.every((job) => job.status === "canceled"), true);

    await db.customBuild.update({
      where: { id: rows[0]!.id },
      data: { storedByteSize: 1024 * 1024 * 1024 },
    });
    await assert.rejects(
      () => createSavedGenerations({
        ownerId,
        prompt: "Another build",
        gridSize: 64,
        palette: "simple",
        models: [{ id: "three", kind: "catalog", modelKey: "openai_gpt_5_4_mini" }],
        providerKeys: { openai: "request-only-secret" },
      }),
      (error: unknown) =>
        error instanceof GenerationServiceError && error.code === "storage_failsafe",
    );

    console.log("Gallery generation application-service checks passed");
  } finally {
    await db.customBuild.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await db.$disconnect();
    if (previousHostedKey === undefined) delete process.env.MINEBENCH_FREE_OPENROUTER_API_KEY;
    else process.env.MINEBENCH_FREE_OPENROUTER_API_KEY = previousHostedKey;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
