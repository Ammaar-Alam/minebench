import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("Gallery admin checks require pnpm test:integration");
    return;
  }

  const db = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const memberId = randomUUID();
  const now = new Date("2026-08-26T17:00:00.000Z");
  const memberSession = `admin-member-${suffix}`;
  const memberIpHmac = `member-ip-${suffix}`;
  const guestSession = `admin-guest-${suffix}`;
  const staleSession = `admin-stale-${suffix}`;
  const extraSessions = Array.from({ length: 252 }, (_, index) => `admin-online-${suffix}-${index}`);
  extraSessions.push(`${memberSession}-other`);
  const promptText = `Gallery admin fixture ${suffix}`;
  const modelAKey = `admin-a-${suffix}`;
  const modelBKey = `admin-b-${suffix}`;
  let routeSession: string | null = null;

  const {
    getGalleryAdminDashboard,
    getGalleryAdminPerson,
    GalleryServiceError,
    setGalleryCandidateHidden,
    setGalleryPersonVoteBlocked,
    setGalleryPublishingSuspension,
    setHostedGenerationLimit,
  } = await import("../../../lib/gallery/service");
  const { listAdminGenerations, getAdminGenerationArtifact, getOwnedGenerationArtifact, getSavedGeneration } = await import("../../../lib/generations/service");
  const { GET: listGenerationRoute } = await import("../../../app/api/admin/generations/route");
  const { GET: generationArtifactRoute } = await import("../../../app/api/admin/generations/[id]/route");
  const { touchPublicSessionActivity } = await import("../../../lib/publicPresence");
  const { hashVoteSession } = await import("../../../lib/voteBlock");
  const { POST: recordPresence } = await import("../../../app/api/presence/route");

  try {
    await db.user.createMany({
      data: [
        { id: adminId, email: `admin-${suffix}@example.test`, isMineBenchAdmin: true },
        {
          id: memberId,
          email: `member-${suffix}@example.test`,
          publicNickname: "Builder",
          totalGenerationCount: 2,
          hostedGenerationCount: 7,
          hostedGenerationLimit: 125,
        },
      ],
    });
    await db.customBuild.createMany({
      data: [
        {
          publicId: `cst_admin_one_${suffix}`,
          ownerId: memberId,
          promptText,
          promptSha256: "a".repeat(64),
          gridSize: 64,
          palette: "simple",
          modelKind: "catalog",
          modelProvider: "gemini",
          modelId: "gemini-3.7-flash",
          modelDisplayName: "Gemini 3.7 Flash",
          usesHostedGeneration: true,
        },
        {
          publicId: `cst_admin_two_${suffix}`,
          ownerId: memberId,
          promptText,
          promptSha256: "b".repeat(64),
          gridSize: 64,
          palette: "simple",
          modelKind: "catalog",
          modelProvider: "gemini",
          modelId: "gemini-3.7-flash",
          modelDisplayName: "Gemini 3.7 Flash",
          removedAt: now,
        },
      ],
    });
    const presenceResponse = await recordPresence(new Request("http://localhost/api/presence", { method: "POST" }));
    assert.equal(presenceResponse.status, 204);
    routeSession = presenceResponse.headers.get("set-cookie")?.match(/mb_session=([^;]+)/)?.[1] ?? null;
    assert.ok(routeSession);
    assert.ok(await db.publicSessionActivity.findUnique({ where: { sessionId: routeSession } }));
    const prompt = await db.prompt.create({ data: { text: promptText } });
    const [modelA, modelB] = await Promise.all([
      db.model.create({
        data: {
          key: modelAKey,
          provider: "test",
          modelId: modelAKey,
          displayName: "Admin Model A",
        },
      }),
      db.model.create({
        data: {
          key: modelBKey,
          provider: "test",
          modelId: modelBKey,
          displayName: "Admin Model B",
        },
      }),
    ]);
    const [buildA, buildB] = await Promise.all([
      db.build.create({
        data: {
          promptId: prompt.id,
          modelId: modelA.id,
          gridSize: 64,
          palette: "simple",
          mode: "web",
          blockCount: 1,
          generationTimeMs: 1_000,
        },
      }),
      db.build.create({
        data: {
          promptId: prompt.id,
          modelId: modelB.id,
          gridSize: 64,
          palette: "simple",
          mode: "web",
          blockCount: 1,
          generationTimeMs: 1_000,
        },
      }),
    ]);
    const matchup = await db.matchup.create({
      data: {
        promptId: prompt.id,
        modelAId: modelA.id,
        modelBId: modelB.id,
        buildAId: buildA.id,
        buildBId: buildB.id,
      },
    });
    const candidate = await db.galleryCandidate.create({
      data: {
        publicId: `gal_admin_${suffix}`,
        promptText,
        promptKey: `admin-${suffix}`,
        uploaderId: memberId,
      },
    });
    await Promise.all([
      db.vote.create({
        data: { matchupId: matchup.id, sessionId: memberSession, userId: memberId, choice: "A" },
      }),
      db.galleryVote.create({
        data: { candidateId: candidate.id, sessionId: memberSession, userId: memberId },
      }),
      touchPublicSessionActivity({
        sessionId: memberSession,
        userId: memberId,
        ipHmac: memberIpHmac,
        now,
        location: { city: "Princeton", countryRegion: "NJ", country: "US" },
      }),
      touchPublicSessionActivity({
        sessionId: guestSession,
        userId: null,
        now: new Date(now.getTime() - 60_000),
        location: { city: "New York", countryRegion: "NY", country: "US" },
      }),
      touchPublicSessionActivity({
        sessionId: staleSession,
        userId: null,
        now: new Date(now.getTime() - 11 * 60_000),
        location: { city: "Boston", countryRegion: "MA", country: "US" },
      }),
    ]);

    await setGalleryCandidateHidden(adminId, candidate.publicId, true);
    await setGalleryCandidateHidden(adminId, candidate.publicId, true);
    let dashboard = await getGalleryAdminDashboard(adminId, { now });
    const hidden = dashboard.prompts.find((item) => item.publicId === candidate.publicId);
    assert.equal(hidden?.hidden, true);
    assert.equal(await db.galleryModerationRecord.count({
      where: { candidateId: candidate.id, action: "admin_hidden" },
    }), 1);

    await setGalleryCandidateHidden(adminId, candidate.publicId, false);
    dashboard = await getGalleryAdminDashboard(adminId, { now });
    assert.equal(dashboard.prompts.find((item) => item.publicId === candidate.publicId)?.hidden, false);
    assert.equal(dashboard.people.filter((person) => person.online).length, 3);
    assert.equal(dashboard.people.some((person) => person.label.includes(memberSession)), false);
    assert.equal(dashboard.people.some((person) => person.location === "New York, NY, US"), true);

    const member = dashboard.people.find((person) => person.id === `user:${memberId}`);
    assert.ok(member);
    assert.equal(member.totalGenerationCount, 2);
    assert.equal(member.hostedGenerationCount, 7);
    assert.equal(member.hostedGenerationLimit, 125);
    const detail = await getGalleryAdminPerson(adminId, member!.id);
    assert.deepEqual(new Set(detail.votes.map((vote) => vote.source)), new Set(["Arena", "Gallery"]));
    assert.equal(JSON.stringify(detail).includes(memberSession), false);
    assert.equal(detail.totalGenerationCount, 2, "removed generations remain part of the lifetime total");
    assert.equal(detail.hostedGenerationCount, 7);
    assert.equal(detail.hostedGenerationLimit, 125);

    const publicId = `cst_admin_one_${suffix}`;
    const removedPublicId = `cst_admin_two_${suffix}`;
    const generations = await listAdminGenerations(adminId, { ownerId: memberId, active: true });
    assert.equal(generations.items.length, 1, "active unpublished generations are visible to admins");
    assert.equal(generations.items[0]?.prompt, promptText);
    assert.equal(generations.items[0]?.owner?.id, memberId);
    assert.equal(generations.items[0]?.published, false);
    assert.equal(generations.items[0]?.viewerUrl, null);
    assert.equal((await listAdminGenerations(adminId, { ownerId: adminId })).items.length, 0);
    assert.equal((await listAdminGenerations(adminId, { query: `member-${suffix}@example.test` })).items.length, 1);
    assert.equal((await listAdminGenerations(adminId, { query: `missing-${suffix}` })).items.length, 0);
    await assert.rejects(() => listAdminGenerations(memberId), (error: unknown) => error instanceof GalleryServiceError && error.code === "forbidden");
    await assert.rejects(() => getAdminGenerationArtifact(memberId, publicId, ["viewer_mbv4"]), (error: unknown) => error instanceof GalleryServiceError && error.code === "forbidden");
    assert.equal((await listGenerationRoute(new Request("http://localhost/api/admin/generations"))).status, 401);
    assert.equal((await generationArtifactRoute(new Request(`http://localhost/api/admin/generations/${publicId}?artifact=viewer`), { params: Promise.resolve({ id: publicId }) })).status, 401);

    await db.customBuild.update({ where: { publicId: removedPublicId }, data: { removedAt: null } });
    const firstPage = await listAdminGenerations(adminId, { ownerId: memberId, limit: 1 });
    assert.ok(firstPage.nextCursor);
    const secondPage = await listAdminGenerations(adminId, { ownerId: memberId, limit: 1, cursor: firstPage.nextCursor });
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(firstPage.items[0]?.id, secondPage.items[0]?.id);
    assert.equal(secondPage.nextCursor, null);
    await db.customBuild.update({ where: { publicId: removedPublicId }, data: { removedAt: now } });
    const completed = await db.customBuild.update({ where: { publicId }, data: { status: "succeeded", generationTimeMs: 1_200_000 } });
    await db.customBuildArtifact.create({ data: {
      customBuildId: completed.id,
      kind: "viewer_mbv4",
      format: "mbv4",
      bucket: "private-builds",
      path: `admin/${suffix}/viewer.mbv4`,
      contentType: "application/octet-stream",
      fileName: "viewer.mbv4",
      sha256: "c".repeat(64),
      byteSize: 10,
      storedByteSize: 10,
    } });
    const ready = (await listAdminGenerations(adminId, { ownerId: memberId })).items[0]!;
    assert.equal(ready.viewerUrl, `/api/admin/generations/${publicId}?artifact=viewer`);
    assert.equal(ready.generationTimeMs, 1_200_000);
    assert.equal((await listAdminGenerations(adminId, { ownerId: memberId, active: true })).items.length, 0);
    assert.ok(await getAdminGenerationArtifact(adminId, publicId, ["viewer_mbv4"]));
    assert.equal(await getOwnedGenerationArtifact(adminId, publicId, ["viewer_mbv4"]), null, "ordinary owner routes remain owner-only even for admins");
    assert.equal(await getSavedGeneration(adminId, publicId), null);
    assert.ok(await getOwnedGenerationArtifact(memberId, publicId, ["viewer_mbv4"]));
    await db.customBuild.update({ where: { publicId }, data: { removedAt: now } });
    assert.equal(await getAdminGenerationArtifact(adminId, publicId, ["viewer_mbv4"]), null, "removed artifacts remain unavailable to admins");
    await db.customBuild.update({ where: { publicId }, data: { removedAt: null } });
    await db.user.update({ where: { id: adminId }, data: { deletedAt: now } });
    await assert.rejects(() => listAdminGenerations(adminId), (error: unknown) => error instanceof GalleryServiceError && error.code === "forbidden");
    await db.user.update({ where: { id: adminId }, data: { deletedAt: null } });

    await setHostedGenerationLimit(adminId, memberId, 0);
    assert.deepEqual(
      await db.user.findUniqueOrThrow({
        where: { id: memberId },
        select: { hostedGenerationCount: true, hostedGenerationLimit: true },
      }),
      { hostedGenerationCount: 7, hostedGenerationLimit: 0 },
      "changing the promotional cap must not change usage or the lifetime generation total",
    );
    await setHostedGenerationLimit(adminId, memberId, 4);
    assert.equal((await getGalleryAdminPerson(adminId, member!.id)).hostedGenerationLimit, 4);
    await assert.rejects(
      () => setHostedGenerationLimit(adminId, memberId, -1),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "invalid_request",
    );
    await assert.rejects(
      () => setHostedGenerationLimit(memberId, memberId, 100),
      (error: unknown) => error instanceof GalleryServiceError && error.code === "forbidden",
    );

    await setGalleryPublishingSuspension(adminId, memberId, { suspended: true });
    await setGalleryPublishingSuspension(adminId, memberId, { suspended: true });
    assert.equal(await db.galleryModerationRecord.count({
      where: { subjectUserId: memberId, action: "suspended" },
    }), 1);

    await setGalleryPersonVoteBlocked(adminId, member!.id, true);
    await setGalleryPersonVoteBlocked(adminId, member!.id, true);
    assert.equal(await db.galleryVoteBlock.count({
      where: {
        reversedAt: null,
        OR: [
          { userId: memberId },
          { sessionHash: hashVoteSession(memberSession) },
          { ipHmac: memberIpHmac },
        ],
      },
    }), 3, "blocking an account should bind every known vote identity once");
    await setGalleryPersonVoteBlocked(adminId, member!.id, false);
    assert.equal(await db.galleryVoteBlock.count({
      where: {
        reversedAt: null,
        OR: [
          { userId: memberId },
          { sessionHash: hashVoteSession(memberSession) },
          { ipHmac: memberIpHmac },
        ],
      },
    }), 0);

    await db.publicSessionActivity.createMany({
      data: extraSessions.map((sessionId, index) => ({
        sessionId,
        userId: sessionId === `${memberSession}-other` ? memberId : null,
        lastSeenAt: new Date(now.getTime() - (index === 251 ? 10 * 60_000 : 0)),
      })),
    });
    dashboard = await getGalleryAdminDashboard(adminId, { now });
    assert.equal(dashboard.onlinePeopleCount, 255, "online count includes boundary sessions beyond the list cap and counts signed-in people once");
    assert.ok(dashboard.onlinePeopleCount > dashboard.people.filter((person) => person.online).length);
    assert.equal(dashboard.refreshedAt, now.toISOString());

    console.log("Gallery admin dashboard checks passed");
  } finally {
    await db.galleryVoteBlock.deleteMany({ where: { OR: [{ userId: memberId }, { createdById: adminId }] } });
    await db.publicSessionActivity.deleteMany({
      where: { sessionId: { in: [memberSession, guestSession, staleSession, ...extraSessions, ...(routeSession ? [routeSession] : [])] } },
    });
    await db.galleryModerationRecord.deleteMany({ where: { OR: [{ actorUserId: adminId }, { subjectUserId: memberId }] } });
    await db.galleryCandidate.deleteMany({ where: { uploaderId: memberId } });
    await db.customBuild.deleteMany({ where: { ownerId: memberId } });
    await db.vote.deleteMany({ where: { sessionId: memberSession } });
    await db.matchup.deleteMany({ where: { prompt: { text: promptText } } });
    await db.build.deleteMany({ where: { prompt: { text: promptText } } });
    await db.model.deleteMany({ where: { key: { in: [modelAKey, modelBKey] } } });
    await db.prompt.deleteMany({ where: { text: promptText } });
    await db.user.deleteMany({ where: { id: { in: [memberId, adminId] } } });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
