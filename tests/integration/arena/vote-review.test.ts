import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) return;
  const db = new PrismaClient();
  const { getArenaVoteReview, getArenaVotePage, setArenaVoteReviewKept, setArenaVoteSessionBlocked } = await import("../../../lib/arena/voteReview");
  const { hashVoteSession } = await import("../../../lib/voteBlock");
  const adminId = randomUUID(), memberId = randomUUID(), suffix = randomUUID();
  const sessionId = `review-${suffix}`, peerSession = `review-peer-${suffix}`;
  const oldBlockedSession = `review-restricted-${suffix}`;
  const hashOnlySession = `review-hash-${suffix}`, accountOnlySession = `review-account-${suffix}`;
  const now = new Date();
  const capturedAt = new Date(now.getTime() - 60_000);
  try {
    await db.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, isMineBenchAdmin: true },
      { id: memberId, email: `${memberId}@example.test` },
    ] });
    await assert.rejects(() => getArenaVoteReview(memberId), /admin access/);
    await assert.rejects(() => getArenaVotePage(memberId, sessionId), /admin access/);
    await assert.rejects(() => setArenaVoteSessionBlocked(memberId, sessionId, true), /admin access/);
    await assert.rejects(() => setArenaVoteReviewKept(memberId, sessionId, true), /admin access/);
    const models = await Promise.all(Array.from({ length: 8 }, (_, i) => db.model.create({ data: {
      key: `review-${suffix}-${i}`, provider: "test", modelId: `review-${i}`, displayName: `Review ${i}`,
      rankSnapshots: { create: { capturedAt, rank: i + 1, rankScore: 1500 - i, confidence: 80 } },
    } })));
    const prompt = await db.prompt.create({ data: { text: `Review ${suffix}` } });
    const builds = await Promise.all([models[0], models[7]].map(model => db.build.create({ data: {
      modelId: model.id, promptId: prompt.id, gridSize: 256, palette: "simple", mode: "precise", blockCount: 1, generationTimeMs: 1,
    } })));
    const matchup = await db.matchup.create({ data: {
      modelAId: models[0].id, modelBId: models[7].id, buildAId: builds[0].id, buildBId: builds[1].id, promptId: prompt.id,
    } });
    await db.publicSessionActivity.createMany({ data: [
      { sessionId, city: "Review City", country: "BE", ipHmac: `review-ip-${suffix}`, lastSeenAt: capturedAt },
      { sessionId: peerSession, ipHmac: `review-ip-${suffix}`, lastSeenAt: capturedAt },
      { sessionId: hashOnlySession, lastSeenAt: capturedAt },
      { sessionId: accountOnlySession, userId: memberId, lastSeenAt: capturedAt },
      { sessionId: oldBlockedSession, ipHmac: `review-old-ip-${suffix}`, lastSeenAt: capturedAt },
    ] });
    // use distinct matchups because one vote per matchup/session is enforced
    for (let i = 0; i < 21; i++) {
      const match = i === 0 ? matchup : await db.matchup.create({ data: {
        modelAId: models[0].id, modelBId: models[7].id, buildAId: builds[0].id, buildBId: builds[1].id, promptId: prompt.id,
      } });
      await db.vote.create({ data: { sessionId, matchupId: match.id, choice: i < 11 ? "B" : "BOTH_BAD", createdAt: new Date(now.getTime() - (22 - i) * 1000) } });
    }
    await db.vote.create({ data: { sessionId, matchupId: (await db.matchup.create({ data: {
      modelAId: models[0].id, modelBId: models[7].id, buildAId: builds[0].id, buildBId: builds[1].id, promptId: prompt.id,
    } })).id, choice: "A", createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000) } });
    await db.vote.create({ data: { sessionId: peerSession, matchupId: matchup.id, choice: "A", createdAt: new Date(now.getTime() - 1000) } });
    await setArenaVoteSessionBlocked(adminId, oldBlockedSession, true);
    await db.galleryVoteBlock.createMany({ data: [
      { sessionHash: hashVoteSession(hashOnlySession), createdById: adminId },
      { userId: memberId, createdById: adminId },
    ] });
    const review = await getArenaVoteReview(adminId);
    assert.equal(review.sessions[0]?.sessionId, peerSession, "the latest vote sorts ahead of a higher-volume session");
    const peerVote = (await getArenaVotePage(adminId, peerSession)).votes[0];
    assert.equal(review.sessions[0]?.lastVoteId, peerVote.id);
    const tiedVote = await db.vote.create({ data: {
      id: `z-${suffix}`, sessionId: peerSession, choice: "B", createdAt: new Date(peerVote.createdAt),
      matchupId: (await db.matchup.findFirstOrThrow({ where: { promptId: prompt.id, id: { not: matchup.id } } })).id,
    } });
    const refreshed = (await getArenaVoteReview(adminId)).sessions.find(row => row.sessionId === peerSession)!;
    assert.equal(refreshed.lastVoteAt, peerVote.createdAt);
    assert.equal(refreshed.lastVoteId, tiedVote.id, "summary and history use the same cursor for tied timestamps");
    assert.equal((await getArenaVotePage(adminId, peerSession)).votes[0].id, refreshed.lastVoteId);
    for (const id of [hashOnlySession, accountOnlySession]) {
      const restricted = review.sessions.find(row => row.sessionId === id);
      assert.equal(restricted?.blocked, true, "retain restrictions without votes or IPs");
      assert.equal(restricted?.votes, 0);
    }
    assert.equal(review.sessions.find(row => row.sessionId === accountOnlySession)?.label, `${memberId}@example.test`);
    await setArenaVoteSessionBlocked(adminId, hashOnlySession, false);
    assert.equal(await db.galleryVoteBlock.count({ where: { sessionHash: hashVoteSession(hashOnlySession), reversedAt: null } }), 0);

    const row = review.sessions.find(row => row.sessionId === sessionId)!;
    assert.equal(row.votes, 22, "flags cover votes older than the last 24 hours");
    assert.equal(row.sharedPairs, 1);
    // one A and eleven B against a peer who picked A, both-bad votes carry no opinion
    assert.ok(Math.abs(row.agreement! - 1 / 12) < 1e-9);
    assert.equal(row.matchingSessions, 2);
    assert.equal(row.medianGapSeconds, 1);
    assert.deepEqual(row.flags, ["Rapid voting", "Frequent rejections", "Repeated matchups"]);
    assert.equal(row.person, sessionId);
    assert.equal(row.kept, false);
    await setArenaVoteReviewKept(adminId, row.person, true);
    await setArenaVoteReviewKept(adminId, row.person, true);
    assert.equal((await getArenaVoteReview(adminId)).sessions.find(row => row.sessionId === sessionId)?.kept, true);
    await setArenaVoteReviewKept(adminId, row.person, false);
    assert.equal((await getArenaVoteReview(adminId)).sessions.find(row => row.sessionId === sessionId)?.kept, false);
    const sharedPairs = async () => (await getArenaVoteReview(adminId)).sessions.find(row => row.sessionId === sessionId)?.sharedPairs;
    const peerBlock = await db.galleryVoteBlock.create({ data: { sessionHash: hashVoteSession(peerSession), createdById: adminId } });
    assert.equal(await sharedPairs(), 0, "restricted votes do not count toward anyone's agreement");
    await db.galleryVoteBlock.delete({ where: { id: peerBlock.id } });
    assert.equal(await sharedPairs(), 1);
    // a stand-in for Supabase storage, replacing the second build after this session voted
    await db.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS storage");
    await db.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS storage.objects (bucket_id text, name text, updated_at timestamptz)");
    await db.build.update({ where: { id: builds[1].id }, data: { voxelStorageBucket: "review", voxelStoragePath: suffix } });
    await db.$executeRaw`INSERT INTO storage.objects (bucket_id, name, updated_at) VALUES ('review', ${suffix}, ${new Date(now.getTime() - 1500)})`;
    assert.equal(await sharedPairs(), 0, "votes on a replaced build version do not count toward agreement");
    assert.equal(review.sessions.find(row => row.sessionId === oldBlockedSession)?.blocked, true);
    assert.equal(review.sessions.find(row => row.sessionId === oldBlockedSession)?.votes, 0);
    const page = await getArenaVotePage(adminId, sessionId);
    assert.equal(page.votes.length, 22);
    assert.equal(page.votes[0].rankA, 1);
    assert.equal(page.votes[0].rankB, 8);
    const before = page.votes[10];
    const older = await getArenaVotePage(adminId, sessionId, { id: before.id, createdAt: before.createdAt });
    assert.equal(older.votes.length, 11);
    assert(!older.votes.some(vote => vote.id === before.id));
    await setArenaVoteSessionBlocked(adminId, sessionId, true);
    await setArenaVoteSessionBlocked(adminId, sessionId, true);
    assert.equal(await db.galleryVoteBlock.count({ where: { createdById: adminId, sessionHash: hashVoteSession(sessionId), reversedAt: null } }), 1);
    assert.equal((await getArenaVoteReview(adminId)).sessions.find(row => row.sessionId === sessionId)?.blocked, true);
    await setArenaVoteSessionBlocked(adminId, sessionId, false);
    assert.equal((await getArenaVoteReview(adminId)).sessions.find(row => row.sessionId === sessionId)?.blocked, false);
    await db.vote.updateMany({ where: { sessionId }, data: { userId: memberId } });
    await db.publicSessionActivity.update({ where: { sessionId }, data: { userId: memberId } });
    await setArenaVoteSessionBlocked(adminId, sessionId, true);
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: memberId, reversedAt: null } }), 1);
    await db.vote.deleteMany({ where: { sessionId } });
    const cleared = (await getArenaVoteReview(adminId)).sessions.find(row => row.sessionId === sessionId);
    assert.equal(cleared?.blocked, true);
    assert.equal(cleared?.votes, 0);
    await setArenaVoteSessionBlocked(adminId, sessionId, false);
    assert.equal(await db.galleryVoteBlock.count({ where: { userId: memberId, reversedAt: null } }), 0);
    assert.equal(await db.galleryVoteBlock.count({ where: { sessionHash: hashVoteSession(accountOnlySession), reversedAt: null } }), 0);

    console.log("vote review database checks passed");
  } finally {
    await db.galleryVoteBlock.deleteMany({ where: { createdById: adminId } });
    await db.$executeRaw`DELETE FROM storage.objects WHERE bucket_id = 'review' AND name = ${suffix}`.catch(() => undefined);
    await db.arenaVoteReviewKeep.deleteMany({ where: { createdById: adminId } });
    await db.galleryModerationRecord.deleteMany({ where: { actorUserId: adminId } });
    await db.publicSessionActivity.deleteMany({ where: { sessionId: { in: [sessionId, peerSession, oldBlockedSession, hashOnlySession, accountOnlySession] } } });
    await db.prompt.deleteMany({ where: { text: `Review ${suffix}` } });
    await db.model.deleteMany({ where: { key: { startsWith: `review-${suffix}` } } });
    await db.user.deleteMany({ where: { id: { in: [adminId, memberId] } } });
    await db.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
