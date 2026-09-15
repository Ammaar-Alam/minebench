import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) return;
  const db = new PrismaClient();
  const { getArenaVoteReview, setArenaVoteSessionBlocked } = await import("../../../lib/arena/voteReview");
  // admin plus three members. "lex" has the lexicographically largest id so the old
  // MAX("userId"::text) summary would pick it even when it is not the most recent voter.
  const suffix = randomUUID();
  const adminId = randomUUID();
  const lexId = "ffffff00-0000-0000-0000-000000000000";
  const recentId = "00000000-0000-0000-0000-00000000ffff";
  const presenceId = "11111111-1111-1111-1111-111111111111";
  const lexEmail = `lex-${suffix}@example.test`;
  const recentEmail = `recent-${suffix}@example.test`;
  const presenceEmail = `presence-${suffix}@example.test`;
  const zSession = `target-z-${suffix}`;
  const wSession = `target-w-${suffix}`;
  const now = new Date();
  let promptId = "";
  const modelIds: string[] = [];
  try {
    await db.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, isMineBenchAdmin: true },
      { id: lexId, email: lexEmail },
      { id: recentId, email: recentEmail },
      { id: presenceId, email: presenceEmail },
    ] });
    await assert.rejects(() => setArenaVoteSessionBlocked(lexId, zSession, true), /admin access/);

    const modelA = await db.model.create({ data: {
      key: `target-a-${suffix}`, provider: "test", modelId: `target-a-${suffix}`, displayName: "Target A",
    } });
    const modelB = await db.model.create({ data: {
      key: `target-b-${suffix}`, provider: "test", modelId: `target-b-${suffix}`, displayName: "Target B",
    } });
    modelIds.push(modelA.id, modelB.id);
    const prompt = await db.prompt.create({ data: { text: `Target ${suffix}` } });
    promptId = prompt.id;
    const buildA = await db.build.create({ data: {
      modelId: modelA.id, promptId: prompt.id, gridSize: 256, palette: "simple", mode: "precise", blockCount: 1, generationTimeMs: 1,
    } });
    const buildB = await db.build.create({ data: {
      modelId: modelB.id, promptId: prompt.id, gridSize: 256, palette: "simple", mode: "precise", blockCount: 1, generationTimeMs: 1,
    } });

    const zOlder = await db.matchup.create({ data: {
      modelAId: modelA.id, modelBId: modelB.id, buildAId: buildA.id, buildBId: buildB.id, promptId: prompt.id,
    } });
    await db.vote.create({ data: {
      sessionId: zSession, matchupId: zOlder.id, choice: "A", userId: lexId, createdAt: new Date(now.getTime() - 200_000),
    } });
    const zNewer = await db.matchup.create({ data: {
      modelAId: modelA.id, modelBId: modelB.id, buildAId: buildA.id, buildBId: buildB.id, promptId: prompt.id,
    } });
    await db.vote.create({ data: {
      sessionId: zSession, matchupId: zNewer.id, choice: "B", userId: recentId, createdAt: new Date(now.getTime() - 50_000),
    } });
    await db.publicSessionActivity.create({ data: {
      sessionId: zSession, userId: recentId, ipHmac: `target-z-ip-${suffix}`, lastSeenAt: new Date(now.getTime() - 50_000),
    } });

    const wRecent = await db.matchup.create({ data: {
      modelAId: modelA.id, modelBId: modelB.id, buildAId: buildA.id, buildBId: buildB.id, promptId: prompt.id,
    } });
    await db.vote.create({ data: {
      sessionId: wSession, matchupId: wRecent.id, choice: "A", createdAt: new Date(now.getTime() - 30_000),
    } });
    const wStale = await db.matchup.create({ data: {
      modelAId: modelA.id, modelBId: modelB.id, buildAId: buildA.id, buildBId: buildB.id, promptId: prompt.id,
    } });
    await db.vote.create({ data: {
      sessionId: wSession, matchupId: wStale.id, choice: "B", userId: lexId, createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    } });
    await db.publicSessionActivity.create({ data: {
      sessionId: wSession, userId: presenceId, ipHmac: `target-w-ip-${suffix}`, lastSeenAt: new Date(now.getTime() - 30_000),
    } });

    const review = await getArenaVoteReview(adminId);
    const zRow = review.sessions.find(row => row.sessionId === zSession);
    const wRow = review.sessions.find(row => row.sessionId === wSession);
    assert.ok(zRow, "the multi-voter session appears in the review");
    assert.equal(zRow!.label, recentEmail, "label must name the most recent voter, not the lexicographic-max userId");
    assert.ok(wRow, "the out-of-window session appears in the review");
    assert.equal(wRow!.label, presenceEmail, "label must fall back to the session's presence user, not an out-of-window voter");

    const zBlock = await setArenaVoteSessionBlocked(adminId, zSession, true);
    assert.equal(zBlock.personId, `user:${recentId}`, "the block targets the user the label named");
    assert.equal(zBlock.label, recentEmail, "the backend returns the label of the person it actually blocked");
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: recentId, reversedAt: null } }), 1);
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: lexId, reversedAt: null } }), 0, "the lexicographic-max voter is not the block target");
    assert.equal((await getArenaVoteReview(adminId)).sessions.find(row => row.sessionId === zSession)!.blocked, true);

    await setArenaVoteSessionBlocked(adminId, zSession, true);
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: recentId, reversedAt: null } }), 1, "re-blocking the same user is idempotent");

    const wBlock = await setArenaVoteSessionBlocked(adminId, wSession, true);
    assert.equal(wBlock.personId, `user:${presenceId}`, "the block targets the in-window presence user, not the stale out-of-window voter");
    assert.equal(wBlock.label, presenceEmail);
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: presenceId, reversedAt: null } }), 1);
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: lexId, reversedAt: null } }), 0, "the out-of-window voter is not the block target");

    await setArenaVoteSessionBlocked(adminId, zSession, false);
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: recentId, reversedAt: null } }), 0);
    await setArenaVoteSessionBlocked(adminId, wSession, false);
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: presenceId, reversedAt: null } }), 0);

    console.log("vote review block-target alignment checks passed");
  } finally {
    await db.galleryVoteBlock.deleteMany({ where: { createdById: adminId } });
    await db.galleryModerationRecord.deleteMany({ where: { actorUserId: adminId } });
    await db.publicSessionActivity.deleteMany({ where: { sessionId: { in: [zSession, wSession] } } });
    if (promptId) await db.prompt.deleteMany({ where: { id: promptId } });
    if (modelIds.length) await db.model.deleteMany({ where: { id: { in: modelIds } } });
    await db.user.deleteMany({ where: { id: { in: [adminId, lexId, recentId, presenceId] } } });
    await db.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
