import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import {
  deleteMineBenchAccount,
  retryPendingAuthDeletions,
} from "../../lib/account/service";
import { getPublicAccount, syncAuthUser } from "../../lib/auth/account";

const db = new PrismaClient();

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("account deletion checks require pnpm test:integration");
    return;
  }

  const suffix = randomUUID().replaceAll("-", "");
  const userId = randomUUID();
  const pendingUserId = randomUUID();
  const adminId = randomUUID();
  const affectedUserId = randomUUID();
  const now = new Date("2026-08-29T15:00:00.000Z");
  const promptId = `account-delete-prompt-${suffix}`;
  const modelAId = `account-delete-model-a-${suffix}`;
  const modelBId = `account-delete-model-b-${suffix}`;
  const buildAId = `account-delete-build-a-${suffix}`;
  const buildBId = `account-delete-build-b-${suffix}`;
  const matchupId = `account-delete-matchup-${suffix}`;
  const voteId = `account-delete-vote-${suffix}`;
  const retainedBuildId = `account-delete-retained-${suffix}`;
  const privateBuildId = `account-delete-private-${suffix}`;
  const runningBuildId = `account-delete-running-${suffix}`;
  const candidatePublicId = `gal_delete_${suffix}`;
  const originalVoteSession = `account-delete-vote-session-${suffix}`;
  const originalGallerySession = `account-delete-gallery-session-${suffix}`;
  const originalActivitySession = `account-delete-activity-session-${suffix}`;
  let organizationId: string | null = null;
  let candidateId: string | null = null;
  let exampleId: string | null = null;
  let galleryVoteId: string | null = null;
  let moderationId: string | null = null;
  let voteBlockId: string | null = null;
  let activityId: string | null = null;

  const customBuildData = (id: string, status: "succeeded" | "running") => ({
    id,
    publicId: `cb_${id}`,
    ownerId: userId,
    status,
    currentStage: status,
    promptText: `Account deletion fixture ${id}`,
    promptSha256: id.padEnd(64, "a").slice(0, 64),
    gridSize: 64,
    palette: "simple",
    modelKind: "catalog",
    modelProvider: "openai",
    modelId: "gpt-5.4-mini",
    modelDisplayName: "GPT 5.4 Mini",
    requestedIpHash: "request-ip-hash",
    requestedUserAgentHash: "request-agent-hash",
  });

  try {
    await db.user.createMany({
      data: [
        {
          id: userId,
          email: `delete-${suffix}@example.test`,
          displayName: "Delete Me",
          publicNickname: `Builder ${suffix.slice(0, 6)}`,
          publicNicknameNormalized: `builder ${suffix.slice(0, 6)}`,
          lastSeenAt: now,
          isMineBenchAdmin: true,
          gallerySuspendedAt: now,
          gallerySuspensionReason: "Test suspension",
          totalGenerationCount: 12,
          hostedGenerationCount: 5,
          hostedGenerationLimit: 20,
        },
        { id: pendingUserId, email: `pending-delete-${suffix}@example.test` },
        { id: adminId, email: `delete-admin-${suffix}@example.test`, isMineBenchAdmin: true },
        {
          id: affectedUserId,
          email: `delete-affected-${suffix}@example.test`,
          gallerySuspendedAt: now,
          gallerySuspendedById: userId,
        },
      ],
    });

    const organization = await db.organization.create({
      data: { slug: `account-delete-${suffix}`, name: "Account deletion fixture" },
    });
    organizationId = organization.id;
    await db.organizationMembership.create({
      data: { organizationId: organization.id, userId, role: "MEMBER" },
    });
    await db.organizationInvitation.create({
      data: {
        organizationId: organization.id,
        email: `delete-${suffix}@example.test`,
        role: "MEMBER",
        authUserId: userId,
        acceptedById: userId,
        acceptedAt: now,
      },
    });

    await db.prompt.create({ data: { id: promptId, text: `Delete fixture ${suffix}`, active: true } });
    await db.model.createMany({
      data: [
        {
          id: modelAId,
          key: `account-delete-a-${suffix}`,
          provider: "Provider",
          modelId: `account-delete-a-${suffix}`,
          displayName: "Delete Alpha",
        },
        {
          id: modelBId,
          key: `account-delete-b-${suffix}`,
          provider: "Provider",
          modelId: `account-delete-b-${suffix}`,
          displayName: "Delete Beta",
        },
      ],
    });
    await db.build.createMany({
      data: [
        {
          id: buildAId,
          promptId,
          modelId: modelAId,
          gridSize: 64,
          palette: "simple",
          mode: "precise",
          blockCount: 1,
          generationTimeMs: 1,
        },
        {
          id: buildBId,
          promptId,
          modelId: modelBId,
          gridSize: 64,
          palette: "simple",
          mode: "precise",
          blockCount: 1,
          generationTimeMs: 1,
        },
      ],
    });
    await db.matchup.create({
      data: {
        id: matchupId,
        promptId,
        modelAId,
        modelBId,
        buildAId,
        buildBId,
      },
    });
    await db.vote.create({
      data: {
        id: voteId,
        matchupId,
        userId,
        sessionId: originalVoteSession,
        choice: "A",
      },
    });

    await db.customBuild.create({
      data: {
        ...customBuildData(retainedBuildId, "succeeded"),
        artifacts: {
          create: {
            kind: "viewer_mbf1",
            format: "mbf1",
            bucket: "builds",
            path: `account-delete/${suffix}/retained.mbf1`,
            contentType: "application/vnd.minebench.mbf1",
            fileName: "retained.mbf1",
            sha256: "a".repeat(64),
            byteSize: 32,
            storedByteSize: 32,
          },
        },
        secret: {
          create: {
            provider: "openai",
            keyCiphertext: "retained-ciphertext",
            keyIv: "retained-iv",
            expiresAt: new Date(now.getTime() + 60_000),
          },
        },
        jobs: { create: { type: "generate", status: "succeeded", completedAt: now } },
        events: { create: { seq: 1, type: "succeeded" } },
      },
    });
    await db.customBuild.create({
      data: {
        ...customBuildData(privateBuildId, "succeeded"),
        artifacts: {
          create: {
            kind: "build_json",
            format: "json.gz",
            bucket: "builds",
            path: `account-delete/${suffix}/private.json.gz`,
            contentType: "application/json",
            fileName: "private.json",
            sha256: "b".repeat(64),
            byteSize: 32,
            storedByteSize: 24,
          },
        },
        secret: {
          create: {
            provider: "openai",
            keyCiphertext: "private-ciphertext",
            keyIv: "private-iv",
            expiresAt: new Date(now.getTime() + 60_000),
          },
        },
      },
    });
    await db.customBuild.create({
      data: {
        ...customBuildData(runningBuildId, "running"),
        artifacts: {
          create: {
            kind: "preview_svg",
            format: "svg",
            bucket: "builds",
            path: `account-delete/${suffix}/running.svg`,
            contentType: "image/svg+xml",
            fileName: "running.svg",
            sha256: "c".repeat(64),
            byteSize: 32,
            storedByteSize: 32,
          },
        },
        secret: {
          create: {
            provider: "openai",
            keyCiphertext: "running-ciphertext",
            keyIv: "running-iv",
            expiresAt: new Date(now.getTime() + 60_000),
          },
        },
        jobs: {
          create: {
            type: "generate",
            status: "running",
            lockedBy: "worker",
            lockedAt: now,
            leaseExpiresAt: new Date(now.getTime() + 60_000),
          },
        },
      },
    });

    const candidate = await db.galleryCandidate.create({
      data: {
        publicId: candidatePublicId,
        promptText: "Public account deletion prompt",
        promptKey: `account-delete-${suffix}`,
        uploaderId: userId,
        selectedAt: now,
        selectedById: userId,
      },
    });
    candidateId = candidate.id;
    const example = await db.galleryExample.create({
      data: {
        candidateId: candidate.id,
        customBuildId: retainedBuildId,
        contributorId: userId,
      },
    });
    exampleId = example.id;
    const galleryVote = await db.galleryVote.create({
      data: {
        candidateId: candidate.id,
        userId,
        sessionId: originalGallerySession,
      },
    });
    galleryVoteId = galleryVote.id;
    const moderation = await db.galleryModerationRecord.create({
      data: {
        kind: "APPEAL",
        target: "ACCOUNT",
        actorUserId: userId,
        subjectUserId: userId,
        note: "Private appeal details",
        safeSnapshot: { email: `delete-${suffix}@example.test` },
        sessionHash: "session-hash",
        ipHmac: "ip-hmac",
      },
    });
    moderationId = moderation.id;
    const voteBlock = await db.galleryVoteBlock.create({
      data: {
        userId,
        sessionHash: "blocked-session",
        ipHmac: "blocked-ip",
        createdById: adminId,
        internalNote: "Private moderation note",
      },
    });
    voteBlockId = voteBlock.id;
    const activity = await db.publicSessionActivity.create({
      data: {
        sessionId: originalActivitySession,
        userId,
        city: "Princeton",
        countryRegion: "New Jersey",
        country: "US",
        ipHmac: "activity-ip",
      },
    });
    activityId = activity.id;

    const deletedAuthUsers: string[] = [];
    assert.deepEqual(await deleteMineBenchAccount(userId, {
      now,
      deleteAuthUser: async (id) => { deletedAuthUsers.push(id); },
    }), { deleted: true });
    assert.deepEqual(deletedAuthUsers, [userId]);

    const tombstone = await db.user.findUniqueOrThrow({ where: { id: userId } });
    assert.match(tombstone.email, /^[0-9a-f-]+@deleted\.minebench\.invalid$/);
    assert.equal(tombstone.displayName, null);
    assert.equal(tombstone.publicNickname, null);
    assert.equal(tombstone.lastSeenAt, null);
    assert.equal(tombstone.isMineBenchAdmin, false);
    assert.equal(tombstone.gallerySuspendedAt, null);
    assert.equal(tombstone.totalGenerationCount, 0);
    assert.equal(tombstone.hostedGenerationCount, 0);
    assert.equal(tombstone.hostedGenerationLimit, 0);
    assert.equal(tombstone.deletedAt?.getTime(), now.getTime());
    assert.equal(tombstone.authDeletedAt?.getTime(), now.getTime());
    assert.equal(await getPublicAccount(userId), null);

    const authUser = {
      id: userId,
      email: `resurrect-${suffix}@example.test`,
      app_metadata: {},
      user_metadata: { full_name: "Must Not Return" },
      aud: "authenticated",
      created_at: now.toISOString(),
    } satisfies SupabaseAuthUser;
    assert.equal(await syncAuthUser(authUser), null);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: userId } })).email, tombstone.email);

    const retained = await db.customBuild.findUniqueOrThrow({
      where: { id: retainedBuildId },
      include: { artifacts: true, jobs: true, events: true, secret: true },
    });
    assert.equal(retained.ownerId, userId);
    assert.equal(retained.removedAt, null);
    assert.equal(retained.requestedIpHash, null);
    assert.equal(retained.requestedUserAgentHash, null);
    assert.equal(retained.artifacts.length, 1);
    assert.equal(retained.jobs.length, 0);
    assert.equal(retained.events.length, 0);
    assert.equal(retained.secret, null);

    const privateBuild = await db.customBuild.findUniqueOrThrow({ where: { id: privateBuildId } });
    assert.equal(privateBuild.ownerId, userId);
    assert.equal(privateBuild.removedAt?.getTime(), now.getTime());
    assert.equal(privateBuild.purgeAt?.getTime(), now.getTime());
    assert.equal(privateBuild.deletionPendingAt?.getTime(), now.getTime());
    const runningBuild = await db.customBuild.findUniqueOrThrow({ where: { id: runningBuildId } });
    assert.equal(runningBuild.ownerId, userId);
    assert.equal(runningBuild.status, "canceled");
    assert.equal(runningBuild.errorCode, "account_deleted");
    assert.equal((await db.customBuildJob.findFirstOrThrow({
      where: { customBuildId: runningBuildId },
    })).status, "canceled");
    assert.equal(await db.customBuildSecret.count({
      where: { customBuildId: { in: [retainedBuildId, privateBuildId, runningBuildId] } },
    }), 0);

    const anonymousCandidate = await db.galleryCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    const anonymousExample = await db.galleryExample.findUniqueOrThrow({ where: { id: example.id } });
    assert.equal(anonymousCandidate.postAnonymously, true);
    assert.equal(anonymousCandidate.selectedById, null);
    assert.equal(anonymousExample.postAnonymously, true);
    assert.equal(anonymousExample.removedAt, null);

    const arenaVote = await db.vote.findUniqueOrThrow({ where: { id: voteId } });
    assert.equal(arenaVote.userId, null);
    assert.notEqual(arenaVote.sessionId, originalVoteSession);
    assert.equal(arenaVote.choice, "A");
    const anonymousGalleryVote = await db.galleryVote.findUniqueOrThrow({ where: { id: galleryVote.id } });
    assert.equal(anonymousGalleryVote.userId, null);
    assert.notEqual(anonymousGalleryVote.sessionId, originalGallerySession);
    const anonymousActivity = await db.publicSessionActivity.findUniqueOrThrow({ where: { id: activity.id } });
    assert.equal(anonymousActivity.userId, null);
    assert.notEqual(anonymousActivity.sessionId, originalActivitySession);
    assert.equal(anonymousActivity.city, null);
    assert.equal(anonymousActivity.ipHmac, null);

    const scrubbedModeration = await db.galleryModerationRecord.findUniqueOrThrow({ where: { id: moderation.id } });
    assert.equal(scrubbedModeration.actorUserId, null);
    assert.equal(scrubbedModeration.subjectUserId, null);
    assert.equal(scrubbedModeration.note, null);
    assert.equal(scrubbedModeration.safeSnapshot, null);
    assert.equal(scrubbedModeration.sessionHash, null);
    assert.equal(scrubbedModeration.ipHmac, null);
    assert.equal(await db.galleryVoteBlock.count({ where: { id: voteBlock.id } }), 0);
    assert.equal(await db.organizationMembership.count({ where: { userId } }), 0);
    assert.equal(await db.organizationInvitation.count({
      where: { OR: [{ authUserId: userId }, { acceptedById: userId }] },
    }), 0);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: affectedUserId } })).gallerySuspendedById, null);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await deleteMineBenchAccount(pendingUserId, {
        now,
        deleteAuthUser: async () => { throw new Error("Auth temporarily unavailable"); },
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: pendingUserId } })).authDeletedAt, null);
    const retriedAuthUsers: string[] = [];
    assert.deepEqual(await retryPendingAuthDeletions({
      now,
      deleteAuthUser: async (id) => { retriedAuthUsers.push(id); },
    }), { deleted: 1, failures: 0 });
    assert.deepEqual(retriedAuthUsers, [pendingUserId]);
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: pendingUserId } })).authDeletedAt?.getTime(),
      now.getTime(),
    );

    console.log("account deletion lifecycle checks passed");
  } finally {
    if (voteBlockId) await db.galleryVoteBlock.deleteMany({ where: { id: voteBlockId } });
    if (moderationId) await db.galleryModerationRecord.deleteMany({ where: { id: moderationId } });
    if (galleryVoteId) await db.galleryVote.deleteMany({ where: { id: galleryVoteId } });
    if (activityId) await db.publicSessionActivity.deleteMany({ where: { id: activityId } });
    if (exampleId) await db.galleryExample.deleteMany({ where: { id: exampleId } });
    if (candidateId) await db.galleryCandidate.deleteMany({ where: { id: candidateId } });
    await db.customBuild.deleteMany({
      where: { id: { in: [retainedBuildId, privateBuildId, runningBuildId] } },
    });
    await db.vote.deleteMany({ where: { id: voteId } });
    await db.matchup.deleteMany({ where: { id: matchupId } });
    await db.build.deleteMany({ where: { id: { in: [buildAId, buildBId] } } });
    await db.model.deleteMany({ where: { id: { in: [modelAId, modelBId] } } });
    await db.prompt.deleteMany({ where: { id: promptId } });
    if (organizationId) await db.organization.deleteMany({ where: { id: organizationId } });
    await db.user.deleteMany({
      where: { id: { in: [userId, pendingUserId, adminId, affectedUserId] } },
    });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
