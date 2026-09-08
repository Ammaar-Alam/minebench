import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import type { sendApnsNotification } from "../../lib/notifications/apns";

process.env.APNS_ENABLED = "true";
delete process.env.APNS_KEY_ID;
delete process.env.APNS_TEAM_ID;
delete process.env.APNS_PRIVATE_KEY;

const db = new PrismaClient();
type PushSend = typeof sendApnsNotification;
type PushSendInput = Parameters<PushSend>[0];
type PushSendResult = Awaited<ReturnType<PushSend>>;

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("notification PostgreSQL checks require pnpm test:integration");
    return;
  }

  const {
    enqueueGenerationNotification,
    enqueueGalleryContribution,
    getNotificationSettings,
    registerPushDevice,
    removePushDevice,
    updateNotificationSettings,
  } = await import("../../lib/notifications/service");
  const { claimPushDeliveries, drainPushNotifications } = await import("../../lib/notifications/delivery");
  const { prisma: appPrisma } = await import("../../lib/prisma");
  const { deleteMineBenchAccount } = await import("../../lib/account/service");
  const { failCustomBuildJob } = await import("../../lib/custom-builds/jobs");
  const { addGalleryExample, setGalleryVote } = await import("../../lib/gallery/service");

  const suffix = randomUUID().replaceAll("-", "");
  let sequence = 0;
  const id = (label: string) => `${label}-${suffix}-${sequence++}`;
  const token = (label: string) => createHash("sha256").update(`${suffix}:${label}`).digest("hex");
  const now = new Date("2026-09-08T17:30:00.000Z");
  const past = new Date(Date.now() - 5_000);

  async function createUser(label: string, data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
    const userId = randomUUID();
    await db.user.create({
      data: {
        id: userId,
        email: `${label}-${suffix}@example.test`,
        ...data,
      },
    });
    return userId;
  }

  async function createDevice(userId: string, label: string) {
    await registerPushDevice(userId, { token: token(label), environment: "development" });
    return db.pushDevice.findUniqueOrThrow({
      where: { token_environment: { token: token(label), environment: "development" } },
    });
  }

  async function createBuild(userId: string, label: string, status: "queued" | "running" | "succeeded" | "failed" = "succeeded", data: Partial<Prisma.CustomBuildUncheckedCreateInput> = {}) {
    const buildId = id(`build-${label}`);
    return db.customBuild.create({
      data: {
        id: buildId,
        publicId: `cb_${suffix}_${label}_${sequence++}`,
        ownerId: userId,
        status,
        currentStage: status,
        completedAt: status === "succeeded" || status === "failed" ? now : null,
        promptText: `Notification fixture ${label}`,
        promptSha256: createHash("sha256").update(`${suffix}:${label}`).digest("hex"),
        gridSize: 64,
        palette: "simple",
        modelKind: "catalog",
        modelProvider: "openai",
        modelId: "gpt-5.4-mini",
        modelDisplayName: "GPT 5.4 Mini",
        ...data,
      },
    });
  }

  async function createGalleryBuild(userId: string, promptText: string, label: string) {
    return createBuild(userId, label, "succeeded", {
      promptText,
      artifacts: {
        create: {
          kind: "build_json",
          format: "json.gz",
          bucket: "builds",
          path: `notifications/${suffix}/${label}.json.gz`,
          contentType: "application/gzip",
          fileName: `${label}.json.gz`,
          sha256: createHash("sha256").update(`${suffix}:${label}:artifact`).digest("hex"),
          byteSize: 12,
          storedByteSize: 12,
        },
      },
    });
  }

  async function createCandidate(userId: string, label: string, data: Partial<Prisma.GalleryCandidateUncheckedCreateInput> = {}) {
    return db.galleryCandidate.create({
      data: {
        publicId: `gal_${suffix}_${label}`,
        promptText: `Gallery prompt ${label} ${suffix}`,
        promptKey: `gallery-${label}-${suffix}`,
        uploaderId: userId,
        ...data,
      },
    });
  }

  async function createDelivery(deviceId: string, userId: string, label: string, data: Partial<Prisma.PushDeliveryUncheckedCreateInput>) {
    return db.pushDelivery.create({
      data: {
        deviceId,
        userId,
        kind: "generation_succeeded",
        subjectId: `subject-${label}`,
        eventKey: `event-${label}-${suffix}`,
        runAfter: past,
        ...data,
      },
    });
  }

  function fakeSend(results: PushSendResult[] = [{ status: 200 }]) {
    const calls: PushSendInput[] = [];
    const pending = [...results];
    const send: PushSend = async (input) => {
      calls.push(input);
      return pending.shift() ?? { status: 200 };
    };
    return { calls, send };
  }

  async function clearQueue() {
    await db.pushDelivery.deleteMany({});
  }

  async function withExpectedPushWarnings(callback: () => Promise<void>) {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await callback();
    } finally {
      console.warn = originalWarn;
    }
  }

  async function waitFor<T>(promise: Promise<T>, label: string) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  try {
    const ownerId = await createUser("notification-owner");
    const otherUserId = await createUser("notification-other");
    const ownerDeviceA = await createDevice(ownerId, "owner-a");
    const ownerDeviceB = await createDevice(ownerId, "owner-b");
    assert.deepEqual(await getNotificationSettings(ownerId), {
      settings: { generations: true, upvotes: true, contributions: true },
      available: true,
    });

    const succeededBuild = await createBuild(ownerId, "succeeded");
    await assert.rejects(
      db.$transaction(async (tx) => {
        await enqueueGenerationNotification(tx, succeededBuild.id);
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(await db.pushDelivery.count({ where: { userId: ownerId } }), 0);

    await db.$transaction((tx) => enqueueGenerationNotification(tx, succeededBuild.id));
    await db.$transaction((tx) => enqueueGenerationNotification(tx, succeededBuild.id));
    let deliveries = await db.pushDelivery.findMany({
      where: { userId: ownerId, kind: "generation_succeeded", subjectId: succeededBuild.publicId },
      orderBy: { deviceId: "asc" },
    });
    assert.equal(deliveries.length, 2, "generation events should enqueue once per account device");
    assert.deepEqual(new Set(deliveries.map((delivery) => delivery.deviceId)), new Set([ownerDeviceA.id, ownerDeviceB.id]));

    const failedBuild = await createBuild(ownerId, "failed-entrypoint", "running");
    const job = await db.customBuildJob.create({
      data: {
        customBuildId: failedBuild.id,
        type: "generate",
        status: "running",
        attempts: 3,
        maxAttempts: 3,
        lockedBy: "worker-a",
        lockedAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
    });
    assert.deepEqual(await failCustomBuildJob(job.id, "worker-a", { code: "provider_failed", message: "provider failed" }), {
      requeued: false,
    });
    assert.equal(
      await db.pushDelivery.count({ where: { userId: ownerId, kind: "generation_failed", subjectId: failedBuild.publicId } }),
      2,
      "terminal generation failure should enqueue through the job entrypoint",
    );

    await updateNotificationSettings(ownerId, { generations: false, upvotes: true, contributions: false });
    assert.equal(
      await db.pushDelivery.count({ where: { userId: ownerId, kind: { in: ["generation_succeeded", "generation_failed"] }, finishedAt: null } }),
      0,
      "disabling generation notifications should finish queued generation deliveries",
    );
    const disabledBuild = await createBuild(ownerId, "disabled-generation");
    await db.$transaction((tx) => enqueueGenerationNotification(tx, disabledBuild.id));
    await db.$transaction((tx) => enqueueGalleryContribution(tx, {
      userId: ownerId,
      contributorId: otherUserId,
      subjectId: "gal_disabled",
      exampleId: "disabled-example",
    }));
    assert.equal(await db.pushDelivery.count({ where: { userId: ownerId, subjectId: { in: [disabledBuild.publicId, "gal_disabled"] } } }), 0);
    await updateNotificationSettings(ownerId, { generations: true, upvotes: true, contributions: true });

    await clearQueue();
    const reboundUserId = await createUser("notification-rebound");
    await registerPushDevice(reboundUserId, { token: token("shared"), environment: "production" });
    const reboundDevice = await db.pushDevice.findUniqueOrThrow({
      where: { token_environment: { token: token("shared"), environment: "production" } },
    });
    await createDelivery(reboundDevice.id, reboundUserId, "old-owner", { kind: "gallery_upvotes", subjectId: "gal_old" });
    await registerPushDevice(ownerId, { token: token("shared"), environment: "production" });
    const rebound = await db.pushDevice.findUniqueOrThrow({
      where: { token_environment: { token: token("shared"), environment: "production" } },
    });
    assert.equal(rebound.userId, ownerId);
    assert.equal(await db.pushDelivery.count({ where: { deviceId: rebound.id, userId: reboundUserId } }), 0);
    await removePushDevice(reboundUserId, { token: token("shared"), environment: "production" });
    assert.equal(await db.pushDevice.count({ where: { id: rebound.id, userId: ownerId } }), 1);

    const cappedUserId = await createUser("notification-capped");
    for (let index = 0; index < 20; index += 1) {
      await registerPushDevice(cappedUserId, { token: token(`cap-${index}`), environment: "development" });
    }
    await assert.rejects(
      registerPushDevice(cappedUserId, { token: token("cap-overflow"), environment: "development" }),
      /Too many registered devices/,
    );
    assert.equal(await db.pushDevice.count({ where: { userId: cappedUserId } }), 20);
    assert.equal(await db.pushDevice.count({ where: { token: token("cap-overflow") } }), 0);
    const capTokenOwnerId = await createUser("notification-cap-token-owner");
    await registerPushDevice(capTokenOwnerId, { token: token("cap-shared"), environment: "production" });
    const capSharedDevice = await db.pushDevice.findUniqueOrThrow({
      where: { token_environment: { token: token("cap-shared"), environment: "production" } },
    });
    await createDelivery(capSharedDevice.id, capTokenOwnerId, "cap-shared", { kind: "gallery_upvotes" });
    await assert.rejects(
      registerPushDevice(cappedUserId, { token: token("cap-shared"), environment: "production" }),
      /Too many registered devices/,
    );
    assert.equal(await db.pushDevice.count({ where: { userId: cappedUserId } }), 20);
    assert.equal((await db.pushDevice.findUniqueOrThrow({ where: { id: capSharedDevice.id } })).userId, capTokenOwnerId);
    assert.equal(await db.pushDelivery.count({ where: { deviceId: capSharedDevice.id, userId: capTokenOwnerId } }), 1);

    await clearQueue();
    const voteOwnerId = await createUser("notification-vote-owner");
    await createDevice(voteOwnerId, "vote-owner");
    const candidate = await createCandidate(voteOwnerId, "votes");
    const firstVoterId = await createUser("notification-voter-one");
    await setGalleryVote({
      publicId: candidate.publicId,
      sessionId: `vote-session-one-${suffix}`,
      userId: firstVoterId,
      upvoted: true,
    });
    const voteDelivery = await db.pushDelivery.findFirstOrThrow({
      where: { userId: voteOwnerId, kind: "gallery_upvotes", subjectId: candidate.publicId },
    });
    assert.ok(voteDelivery.windowStart);
    const windowStart = voteDelivery.windowStart;
    await db.galleryVote.createMany({
      data: [
        {
          candidateId: candidate.id,
          sessionId: `vote-session-two-${suffix}`,
          userId: await createUser("notification-voter-two"),
          createdAt: new Date(windowStart.getTime() + 1_000),
        },
        {
          candidateId: candidate.id,
          sessionId: `vote-session-self-${suffix}`,
          userId: voteOwnerId,
          createdAt: new Date(windowStart.getTime() + 2_000),
        },
        {
          candidateId: candidate.id,
          sessionId: `vote-session-old-${suffix}`,
          userId: await createUser("notification-voter-old"),
          createdAt: new Date(windowStart.getTime() - 1_000),
        },
        {
          candidateId: candidate.id,
          sessionId: `vote-session-removed-${suffix}`,
          userId: await createUser("notification-voter-removed"),
          createdAt: new Date(windowStart.getTime() + 3_000),
        },
      ],
    });
    await db.galleryVote.deleteMany({ where: { sessionId: `vote-session-removed-${suffix}` } });
    await db.pushDelivery.update({ where: { id: voteDelivery.id }, data: { runAfter: past } });
    const voteSend = fakeSend();
    await drainPushNotifications(voteSend.send);
    assert.equal(voteSend.calls.length, 1);
    assert.equal(voteSend.calls[0].payload.aps.alert.body, "Your prompt received 2 new upvotes.");

    await clearQueue();
    const contributionOwnerId = await createUser("notification-contribution-owner");
    const contributorId = await createUser("notification-contributor");
    await createDevice(contributionOwnerId, "contribution-owner");
    const contributionPrompt = `Contribution prompt ${suffix}`;
    const contributionCandidate = await createCandidate(contributionOwnerId, "contribution", {
      promptText: contributionPrompt,
    });
    const contributionBuild = await createGalleryBuild(contributorId, contributionPrompt, "contribution");
    const contribution = await addGalleryExample(contributorId, contributionCandidate.publicId, {
      generationId: contributionBuild.publicId,
      postAnonymously: true,
    });
    assert.equal(contribution.created, true);
    assert.equal(
      await db.pushDelivery.count({ where: { userId: contributionOwnerId, kind: "gallery_contribution", exampleId: contribution.id } }),
      1,
    );
    assert.equal((await addGalleryExample(contributorId, contributionCandidate.publicId, {
      generationId: contributionBuild.publicId,
      postAnonymously: true,
    })).created, false);
    const ownerContributionBuild = await createGalleryBuild(contributionOwnerId, contributionPrompt, "owner-contribution");
    assert.equal((await addGalleryExample(contributionOwnerId, contributionCandidate.publicId, {
      generationId: ownerContributionBuild.publicId,
      postAnonymously: true,
    })).created, true);
    assert.equal(await db.pushDelivery.count({ where: { userId: contributionOwnerId, kind: "gallery_contribution" } }), 1);
    await db.pushDelivery.updateMany({
      where: { userId: contributionOwnerId, kind: "gallery_contribution" },
      data: { runAfter: past },
    });
    const contributionSend = fakeSend();
    await drainPushNotifications(contributionSend.send);
    assert.equal(contributionSend.calls.length, 1);
    assert.equal(contributionSend.calls[0].payload.kind, "gallery_contribution");

    await clearQueue();
    const claimOwnerId = await createUser("notification-claim-owner");
    const claimDevice = await createDevice(claimOwnerId, "claim-owner");
    await Promise.all(Array.from({ length: 12 }, (_, index) => createDelivery(claimDevice.id, claimOwnerId, `claim-${index}`, {
      eventKey: `claim-${index}-${suffix}`,
    })));
    const [claimA, claimB] = await Promise.all([claimPushDeliveries(), claimPushDeliveries()]);
    assert.equal(new Set([...claimA, ...claimB].map((delivery) => delivery.id)).size, claimA.length + claimB.length);
    assert.equal(claimA.length + claimB.length, 12);
    assert.ok([...claimA, ...claimB].every((delivery) => delivery.leaseToken && delivery.leaseExpiresAt));

    await clearQueue();
    const stale = await createDelivery(claimDevice.id, claimOwnerId, "stale", {
      attempts: 1,
      leaseToken: "stale-token",
      leaseExpiresAt: past,
      eventKey: `stale-${suffix}`,
    });
    const staleClaim = await claimPushDeliveries();
    assert.deepEqual(staleClaim.map((delivery) => delivery.id), [stale.id]);
    assert.equal(staleClaim[0].attempts, 2);
    assert.notEqual(staleClaim[0].leaseToken, "stale-token");

    await clearQueue();
    const retryOwnerId = await createUser("notification-retry-owner");
    const retryDeviceA = await createDevice(retryOwnerId, "retry-a");
    const retryDeviceB = await createDevice(retryOwnerId, "retry-b");
    const retryBuild = await createBuild(retryOwnerId, "retry-build");
    const retryEventKey = `generation:${retryBuild.id}:succeeded:${retryBuild.completedAt?.getTime()}`;
    const retryDeliveryA = await createDelivery(retryDeviceA.id, retryOwnerId, "retry-a", {
      kind: "generation_succeeded",
      subjectId: retryBuild.publicId,
      eventKey: retryEventKey,
    });
    const retryDeliveryB = await createDelivery(retryDeviceB.id, retryOwnerId, "retry-b", {
      kind: "generation_succeeded",
      subjectId: retryBuild.publicId,
      eventKey: retryEventKey,
    });
    const retryCalls: PushSendInput[] = [];
    let retriedDeviceB = false;
    const retrySend: PushSend = async (input) => {
      retryCalls.push(input);
      if (input.token === retryDeviceB.token && !retriedDeviceB) {
        retriedDeviceB = true;
        return { status: 500, reason: "InternalServerError" };
      }
      return { status: 200 };
    };
    await withExpectedPushWarnings(() => drainPushNotifications(retrySend));
    assert.equal(retryCalls.length, 2);
    assert.ok((await db.pushDelivery.findUniqueOrThrow({ where: { id: retryDeliveryA.id } })).finishedAt);
    const transient = await db.pushDelivery.findUniqueOrThrow({ where: { id: retryDeliveryB.id } });
    assert.equal(transient.finishedAt, null);
    assert.equal(transient.attempts, 1);
    await db.pushDelivery.update({ where: { id: retryDeliveryB.id }, data: { runAfter: past } });
    await drainPushNotifications(retrySend);
    assert.equal(retryCalls.length, 3);
    assert.equal(retryCalls[2].token, retryDeviceB.token);

    await clearQueue();
    const bookkeepingOwnerId = await createUser("notification-bookkeeping-owner");
    const bookkeepingDeviceA = await createDevice(bookkeepingOwnerId, "bookkeeping-a");
    const bookkeepingDeviceB = await createDevice(bookkeepingOwnerId, "bookkeeping-b");
    const bookkeepingBuild = await createBuild(bookkeepingOwnerId, "bookkeeping-build");
    const bookkeepingEventKey = `generation:${bookkeepingBuild.id}:succeeded:${bookkeepingBuild.completedAt?.getTime()}`;
    const failedBookkeepingDelivery = await createDelivery(bookkeepingDeviceA.id, bookkeepingOwnerId, "bookkeeping-a", {
      kind: "generation_succeeded",
      subjectId: bookkeepingBuild.publicId,
      eventKey: bookkeepingEventKey,
    });
    const deferredBookkeepingDelivery = await createDelivery(bookkeepingDeviceB.id, bookkeepingOwnerId, "bookkeeping-b", {
      kind: "generation_succeeded",
      subjectId: bookkeepingBuild.publicId,
      eventKey: bookkeepingEventKey,
    });
    const pushDelivery = appPrisma.pushDelivery as unknown as {
      updateMany: typeof appPrisma.pushDelivery.updateMany;
    };
    const originalUpdateMany = pushDelivery.updateMany;
    let rejectBookkeepingUpdate: () => void = () => {};
    const bookkeepingUpdateRejected = new Promise<void>((resolve) => {
      rejectBookkeepingUpdate = resolve;
    });
    let startDeferredSend: () => void = () => {};
    const deferredSendStarted = new Promise<void>((resolve) => {
      startDeferredSend = resolve;
    });
    let resolveDeferredSend: (result: PushSendResult) => void = () => {};
    const deferredSend = new Promise<PushSendResult>((resolve) => {
      resolveDeferredSend = resolve;
    });
    let drainSettled = false;
    try {
      pushDelivery.updateMany = (async (...args: Parameters<typeof originalUpdateMany>) => {
        const where = args[0]?.where as { id?: string } | undefined;
        if (where?.id === failedBookkeepingDelivery.id) {
          rejectBookkeepingUpdate();
          throw new Error("bookkeeping update failed");
        }
        return originalUpdateMany.apply(appPrisma.pushDelivery, args);
      }) as unknown as typeof originalUpdateMany;
      const bookkeepingSend: PushSend = async (input) => {
        if (input.token === bookkeepingDeviceB.token) {
          startDeferredSend();
          return deferredSend;
        }
        return { status: 200 };
      };
      const drain = withExpectedPushWarnings(() => drainPushNotifications(bookkeepingSend));
      drain.finally(() => { drainSettled = true; }).catch(() => {});
      await waitFor(Promise.all([bookkeepingUpdateRejected, deferredSendStarted]), "bookkeeping regression setup");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(drainSettled, false, "drain should wait for every claimed delivery to settle");
      let failedBookkeeping = await db.pushDelivery.findUniqueOrThrow({ where: { id: failedBookkeepingDelivery.id } });
      assert.equal(failedBookkeeping.finishedAt, null);
      assert.ok(failedBookkeeping.leaseToken);
      assert.ok(failedBookkeeping.leaseExpiresAt);
      resolveDeferredSend({ status: 200 });
      await waitFor(drain, "bookkeeping regression drain");
      failedBookkeeping = await db.pushDelivery.findUniqueOrThrow({ where: { id: failedBookkeepingDelivery.id } });
      assert.equal(failedBookkeeping.finishedAt, null);
      assert.ok(failedBookkeeping.leaseToken);
      assert.ok((await db.pushDelivery.findUniqueOrThrow({ where: { id: deferredBookkeepingDelivery.id } })).finishedAt);
    } finally {
      resolveDeferredSend({ status: 200 });
      pushDelivery.updateMany = originalUpdateMany;
    }

    await clearQueue();
    const freshOwnerId = await createUser("notification-fresh-owner");
    const freshDevice = await db.pushDevice.create({
      data: { userId: freshOwnerId, token: token("fresh"), environment: "production" },
    });
    const freshBuild = await createBuild(freshOwnerId, "fresh-build");
    await createDelivery(freshDevice.id, freshOwnerId, "fresh-invalid", {
      kind: "generation_succeeded",
      subjectId: freshBuild.publicId,
      eventKey: `generation:${freshBuild.id}:succeeded:${freshBuild.completedAt?.getTime()}`,
    });
    const freshSend = fakeSend([{
      status: 410,
      reason: "Unregistered",
      invalidatedAt: freshDevice.updatedAt.getTime() - 1_000,
    }]);
    await withExpectedPushWarnings(() => drainPushNotifications(freshSend.send));
    assert.equal(await db.pushDevice.count({ where: { id: freshDevice.id } }), 1);

    await clearQueue();
    const invalidOwnerId = await createUser("notification-invalid-owner");
    const invalidDevice = await createDevice(invalidOwnerId, "invalid-owner");
    const deletedOwnerId = await createUser("notification-deleted-owner", { deletedAt: now });
    const deletedDevice = await db.pushDevice.create({
      data: { userId: deletedOwnerId, token: token("deleted-owner"), environment: "development" },
    });
    const removedBuild = await createBuild(invalidOwnerId, "removed-build", "succeeded", { removedAt: now });
    await createDelivery(invalidDevice.id, invalidOwnerId, "removed-build", {
      kind: "generation_succeeded",
      subjectId: removedBuild.publicId,
      eventKey: `generation:${removedBuild.id}:succeeded:${removedBuild.completedAt?.getTime()}`,
    });
    await createDelivery(deletedDevice.id, deletedOwnerId, "deleted-owner", {
      kind: "gallery_upvotes",
      subjectId: "gal_deleted_owner",
      windowStart: now,
    });
    const hiddenCandidate = await createCandidate(invalidOwnerId, "hidden", { adminHiddenAt: now });
    await createDelivery(invalidDevice.id, invalidOwnerId, "hidden-candidate", {
      kind: "gallery_upvotes",
      subjectId: hiddenCandidate.publicId,
      windowStart: now,
    });
    const removedContributionCandidate = await createCandidate(invalidOwnerId, "removed-contribution");
    const removedContributorId = await createUser("notification-removed-contributor");
    const removedContributionBuild = await createGalleryBuild(removedContributorId, removedContributionCandidate.promptText, "removed-contribution");
    const removedExample = await db.galleryExample.create({
      data: {
        candidateId: removedContributionCandidate.id,
        customBuildId: removedContributionBuild.id,
        contributorId: removedContributorId,
        removedAt: now,
      },
    });
    await createDelivery(invalidDevice.id, invalidOwnerId, "removed-example", {
      kind: "gallery_contribution",
      subjectId: removedContributionCandidate.publicId,
      exampleId: removedExample.id,
    });
    const invalidSend = fakeSend();
    await drainPushNotifications(invalidSend.send);
    assert.equal(invalidSend.calls.length, 0);
    assert.equal(await db.pushDelivery.count({ where: { finishedAt: null } }), 0);

    await clearQueue();
    const deletingUserId = await createUser("notification-delete-account");
    const deletingDevice = await createDevice(deletingUserId, "delete-account");
    await updateNotificationSettings(deletingUserId, { generations: true, upvotes: false, contributions: true });
    await createDelivery(deletingDevice.id, deletingUserId, "delete-account", { kind: "gallery_contribution" });
    const deletedAuthUsers: string[] = [];
    assert.deepEqual(await deleteMineBenchAccount(deletingUserId, {
      now,
      deleteAuthUser: async (userId) => { deletedAuthUsers.push(userId); },
    }), { deleted: true });
    assert.deepEqual(deletedAuthUsers, [deletingUserId]);
    assert.equal(await db.pushDevice.count({ where: { userId: deletingUserId } }), 0);
    assert.equal(await db.pushDelivery.count({ where: { userId: deletingUserId } }), 0);
    assert.equal(await db.notificationPreference.count({ where: { userId: deletingUserId } }), 0);

    console.log("notification PostgreSQL checks passed");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
