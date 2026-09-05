import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { GalleryServiceError } from "../../../lib/gallery/service";
import { hashVoteSession } from "../../../lib/voteBlock";
import { removePublicArenaVotes } from "../../../lib/arena/voteModeration";

const db = new PrismaClient();

type ArenaPair = Awaited<ReturnType<typeof createArenaPair>>;
type JobState = "processed" | "pending" | "none";

function orderedPair(modelAId: string, modelBId: string): [string, string] {
  return modelAId < modelBId ? [modelAId, modelBId] : [modelBId, modelAId];
}

function serviceError(code: string, message: RegExp) {
  return (error: unknown) =>
    error instanceof GalleryServiceError && error.code === code && message.test(error.message);
}

async function createArenaPair(suffix: string, label: string) {
  const prompt = await db.prompt.create({
    data: { text: `Vote moderation ${label} ${suffix}`, active: true },
  });
  const modelA = await db.model.create({
    data: {
      key: `vote-mod-${label}-a-${suffix}`,
      provider: "Test",
      modelId: `vote-mod-${label}-a-${suffix}`,
      displayName: `Vote Mod ${label} A`,
    },
  });
  const modelB = await db.model.create({
    data: {
      key: `vote-mod-${label}-b-${suffix}`,
      provider: "Test",
      modelId: `vote-mod-${label}-b-${suffix}`,
      displayName: `Vote Mod ${label} B`,
    },
  });
  const buildA = await db.build.create({
    data: {
      promptId: prompt.id,
      modelId: modelA.id,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      blockCount: 1,
      generationTimeMs: 1,
    },
  });
  const buildB = await db.build.create({
    data: {
      promptId: prompt.id,
      modelId: modelB.id,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      blockCount: 1,
      generationTimeMs: 1,
    },
  });
  return { prompt, modelA, modelB, buildA, buildB };
}

async function createVote(
  pair: ArenaPair,
  sessionId: string,
  choice: "A" | "B" | "TIE" | "BOTH_BAD",
  jobState: JobState,
  stealthVariantId?: string,
) {
  const matchup = await db.matchup.create({
    data: {
      promptId: pair.prompt.id,
      modelAId: pair.modelA.id,
      modelBId: pair.modelB.id,
      buildAId: pair.buildA.id,
      buildBId: pair.buildB.id,
      stealthVariantId,
    },
  });
  const vote = await db.vote.create({
    data: { matchupId: matchup.id, sessionId, choice },
  });
  const job = jobState === "none"
    ? null
    : await db.arenaVoteJob.create({
        data: {
          voteId: vote.id,
          matchupId: matchup.id,
          promptId: pair.prompt.id,
          modelAId: pair.modelA.id,
          modelBId: pair.modelB.id,
          choice,
          processedAt: jobState === "processed" ? new Date() : null,
          stealthVariantId,
        },
      });
  return { matchup, vote, job };
}

async function seedCoverage(pair: ArenaPair, decisiveVotes: number) {
  const [modelLowId, modelHighId] = orderedPair(pair.modelA.id, pair.modelB.id);
  await db.arenaCoverageModelPrompt.createMany({
    data: [
      { modelId: pair.modelA.id, promptId: pair.prompt.id, decisiveVotes },
      { modelId: pair.modelB.id, promptId: pair.prompt.id, decisiveVotes },
    ],
  });
  await db.arenaCoveragePair.create({
    data: { modelLowId, modelHighId, decisiveVotes },
  });
  await db.arenaCoveragePairPrompt.create({
    data: { modelLowId, modelHighId, promptId: pair.prompt.id, decisiveVotes },
  });
}

async function readCounts(pair: ArenaPair) {
  const [modelA, modelB] = await Promise.all([
    db.model.findUniqueOrThrow({ where: { id: pair.modelA.id } }),
    db.model.findUniqueOrThrow({ where: { id: pair.modelB.id } }),
  ]);
  return {
    a: {
      shownCount: modelA.shownCount,
      winCount: modelA.winCount,
      lossCount: modelA.lossCount,
      drawCount: modelA.drawCount,
      bothBadCount: modelA.bothBadCount,
    },
    b: {
      shownCount: modelB.shownCount,
      winCount: modelB.winCount,
      lossCount: modelB.lossCount,
      drawCount: modelB.drawCount,
      bothBadCount: modelB.bothBadCount,
    },
  };
}

async function readCoverage(pair: ArenaPair) {
  const [modelLowId, modelHighId] = orderedPair(pair.modelA.id, pair.modelB.id);
  const [modelA, modelB, pairRow, pairPrompt] = await Promise.all([
    db.arenaCoverageModelPrompt.findUnique({
      where: { modelId_promptId: { modelId: pair.modelA.id, promptId: pair.prompt.id } },
    }),
    db.arenaCoverageModelPrompt.findUnique({
      where: { modelId_promptId: { modelId: pair.modelB.id, promptId: pair.prompt.id } },
    }),
    db.arenaCoveragePair.findUnique({
      where: { modelLowId_modelHighId: { modelLowId, modelHighId } },
    }),
    db.arenaCoveragePairPrompt.findUnique({
      where: {
        modelLowId_modelHighId_promptId: { modelLowId, modelHighId, promptId: pair.prompt.id },
      },
    }),
  ]);
  return {
    modelA: modelA?.decisiveVotes ?? 0,
    modelB: modelB?.decisiveVotes ?? 0,
    pair: pairRow?.decisiveVotes ?? 0,
    pairPrompt: pairPrompt?.decisiveVotes ?? 0,
  };
}

async function auditCount() {
  return db.galleryModerationRecord.count({ where: { action: "arena_votes_removed" } });
}

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("arena vote moderation PostgreSQL checks require pnpm test:integration");
    return;
  }
  const previousVoteSecret = process.env.VOTE_BLOCK_HMAC_SECRET;
  process.env.VOTE_BLOCK_HMAC_SECRET = "vote-moderation-test-secret";
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const adminId = randomUUID();
  const memberId = randomUUID();
  const sessionId = `vote-mod-session-${suffix}`;
  const otherSessionId = `vote-mod-other-${suffix}`;

  try {
    await db.user.createMany({
      data: [
        { id: adminId, email: `vote-mod-admin-${suffix}@example.test`, isMineBenchAdmin: true },
        { id: memberId, email: `vote-mod-member-${suffix}@example.test` },
      ],
    });

    const blockedPair = await createArenaPair(suffix, "blocked");
    const blockedVote = await createVote(blockedPair, sessionId, "A", "pending");
    await assert.rejects(
      () => removePublicArenaVotes(memberId, sessionId, [blockedVote.vote.id]),
      serviceError("forbidden", /MineBench admin access required/),
    );
    assert.equal(await db.vote.count({ where: { id: blockedVote.vote.id } }), 1);
    assert.equal(await auditCount(), 0);

    const rollbackPair = await createArenaPair(suffix, "rollback");
    const rollbackVote = await createVote(rollbackPair, sessionId, "A", "processed");
    const wrongSessionVote = await createVote(rollbackPair, otherSessionId, "B", "processed");
    await db.model.update({
      where: { id: rollbackPair.modelA.id },
      data: { winCount: 1, lossCount: 1 },
    });
    await db.model.update({
      where: { id: rollbackPair.modelB.id },
      data: { winCount: 1, lossCount: 1 },
    });
    await seedCoverage(rollbackPair, 2);
    await assert.rejects(
      () => removePublicArenaVotes(adminId, sessionId, [rollbackVote.vote.id, wrongSessionVote.vote.id]),
      serviceError("not_found", /reviewed public session/),
    );
    assert.equal(await db.vote.count({ where: { id: { in: [rollbackVote.vote.id, wrongSessionVote.vote.id] } } }), 2);
    assert.deepEqual(await readCoverage(rollbackPair), { modelA: 2, modelB: 2, pair: 2, pairPrompt: 2 });
    assert.equal(await auditCount(), 0);

    const privatePair = await createArenaPair(suffix, "private");
    const organization = await db.organization.create({
      data: { slug: `vote-mod-${suffix}`, name: "Vote moderation" },
    });
    const experiment = await db.stealthExperiment.create({
      data: {
        organizationId: organization.id,
        slug: `vote-mod-${suffix}`,
        name: "Vote moderation",
        status: "ACTIVE",
      },
    });
    const variant = await db.stealthVariant.create({
      data: {
        experimentId: experiment.id,
        codename: "Private",
        status: "ACTIVE",
        modelId: privatePair.modelB.id,
        winCount: 3,
      },
    });
    const publicBeforePrivate = await createVote(privatePair, sessionId, "A", "pending");
    const privateVote = await createVote(privatePair, sessionId, "B", "processed", variant.id);
    await assert.rejects(
      () => removePublicArenaVotes(adminId, sessionId, [publicBeforePrivate.vote.id, privateVote.vote.id]),
      serviceError("not_found", /reviewed public session/),
    );
    assert.equal(await db.vote.count({ where: { id: { in: [publicBeforePrivate.vote.id, privateVote.vote.id] } } }), 2);
    assert.equal((await db.stealthVariant.findUniqueOrThrow({ where: { id: variant.id } })).winCount, 3);
    assert.equal(await auditCount(), 0);

    await assert.rejects(
      () => removePublicArenaVotes(adminId, sessionId, [publicBeforePrivate.vote.id, `missing-${suffix}`]),
      serviceError("not_found", /reviewed public session/),
    );
    assert.equal(await db.vote.count({ where: { id: publicBeforePrivate.vote.id } }), 1);
    assert.equal(await auditCount(), 0);

    const undercountPair = await createArenaPair(suffix, "undercount");
    const undercountVote = await createVote(undercountPair, sessionId, "A", "processed");
    await db.model.update({
      where: { id: undercountPair.modelA.id },
      data: { winCount: 1 },
    });
    await db.model.update({
      where: { id: undercountPair.modelB.id },
      data: { lossCount: 1 },
    });
    await assert.rejects(
      () => removePublicArenaVotes(adminId, sessionId, [undercountVote.vote.id]),
      serviceError("conflict", /Arena coverage is lower/),
    );
    assert.equal(await db.vote.count({ where: { id: undercountVote.vote.id } }), 1);
    assert.deepEqual((await readCounts(undercountPair)).a, {
      shownCount: 0,
      winCount: 1,
      lossCount: 0,
      drawCount: 0,
      bothBadCount: 0,
    });
    assert.equal(await auditCount(), 0);

    const removalPair = await createArenaPair(suffix, "remove");
    const selectedA = await createVote(removalPair, sessionId, "A", "processed");
    const selectedBNoJob = await createVote(removalPair, sessionId, "B", "none");
    const selectedTie = await createVote(removalPair, sessionId, "TIE", "processed");
    const selectedBothBad = await createVote(removalPair, sessionId, "BOTH_BAD", "processed");
    const selectedPending = await createVote(removalPair, sessionId, "A", "pending");
    const retained = await createVote(removalPair, otherSessionId, "A", "processed");
    await db.model.update({
      where: { id: removalPair.modelA.id },
      data: { shownCount: 10, winCount: 2, lossCount: 1, drawCount: 1, bothBadCount: 1 },
    });
    await db.model.update({
      where: { id: removalPair.modelB.id },
      data: { shownCount: 20, winCount: 1, lossCount: 2, drawCount: 1, bothBadCount: 1 },
    });
    await seedCoverage(removalPair, 3);
    const selectedVoteIds = [
      selectedA.vote.id,
      selectedBNoJob.vote.id,
      selectedTie.vote.id,
      selectedBothBad.vote.id,
      selectedPending.vote.id,
    ];

    assert.deepEqual(
      await removePublicArenaVotes(adminId, sessionId, selectedVoteIds),
      { removed: selectedVoteIds.length },
    );
    assert.equal(await db.vote.count({ where: { id: { in: selectedVoteIds } } }), 0);
    assert.equal(await db.vote.count({ where: { id: retained.vote.id } }), 1);
    assert.equal(await db.arenaVoteJob.count({ where: { voteId: { in: selectedVoteIds } } }), 0);
    assert.equal(await db.arenaVoteJob.count({ where: { voteId: retained.vote.id } }), 1);
    assert.equal(
      await db.matchup.count({
        where: {
          id: {
            in: [
              selectedA.matchup.id,
              selectedBNoJob.matchup.id,
              selectedTie.matchup.id,
              selectedBothBad.matchup.id,
              selectedPending.matchup.id,
            ],
          },
        },
      }),
      selectedVoteIds.length,
    );
    assert.deepEqual(await readCounts(removalPair), {
      a: { shownCount: 10, winCount: 1, lossCount: 0, drawCount: 0, bothBadCount: 0 },
      b: { shownCount: 20, winCount: 0, lossCount: 1, drawCount: 0, bothBadCount: 0 },
    });
    assert.deepEqual(await readCoverage(removalPair), { modelA: 1, modelB: 1, pair: 1, pairPrompt: 1 });

    const audit = await db.galleryModerationRecord.findFirstOrThrow({
      where: { action: "arena_votes_removed" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(await auditCount(), 1);
    assert.equal(audit.kind, "ADMIN_ACTION");
    assert.equal(audit.target, "VOTE_BLOCK");
    assert.equal(audit.actorUserId, adminId);
    assert.equal(audit.sessionHash, hashVoteSession(sessionId));
    assert.match(audit.note ?? "", new RegExp(String(selectedVoteIds.length)));
    assert.deepEqual(audit.safeSnapshot, { voteIds: selectedVoteIds, removed: selectedVoteIds.length });
    assert.ok(audit.purgeAt);

    console.log("arena vote moderation checks passed");
  } finally {
    if (previousVoteSecret === undefined) delete process.env.VOTE_BLOCK_HMAC_SECRET;
    else process.env.VOTE_BLOCK_HMAC_SECRET = previousVoteSecret;
    try {
      const prompt = { text: { startsWith: "Vote moderation ", endsWith: suffix } };
      await db.matchup.deleteMany({ where: { prompt } });
      await db.prompt.deleteMany({ where: prompt });
      await db.organization.deleteMany({ where: { slug: `vote-mod-${suffix}` } });
      await db.model.deleteMany({ where: { key: { startsWith: "vote-mod-", endsWith: suffix } } });
      await db.galleryModerationRecord.deleteMany({ where: { actorUserId: adminId } });
      await db.user.deleteMany({ where: { id: { in: [adminId, memberId] } } });
    } finally {
      await db.$disconnect();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
