import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

process.env.APNS_ENABLED = "true";
delete process.env.APNS_KEY_ID;
delete process.env.APNS_TEAM_ID;
delete process.env.APNS_PRIVATE_KEY;

const db = new PrismaClient();

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("notification preference PostgreSQL checks require pnpm test:integration");
    return;
  }

  const {
    NOTIFICATION_HOUR_MS,
    enqueueGalleryUpvotes,
    registerPushDevice,
    updateNotificationSettings,
  } = await import("../../lib/notifications/service");

  const suffix = randomUUID().replaceAll("-", "");
  const token = (label: string) => createHash("sha256").update(`${suffix}:${label}`).digest("hex");
  const futureWindowStart = new Date(Math.floor(Date.now() / NOTIFICATION_HOUR_MS) * NOTIFICATION_HOUR_MS + 2 * NOTIFICATION_HOUR_MS);
  const futureAt = new Date(futureWindowStart.getTime() + 5 * 60_000);
  const past = new Date(Date.now() - 60_000);

  async function createUser(label: string) {
    const userId = randomUUID();
    await db.user.create({
      data: {
        id: userId,
        email: `${label}-${suffix}@example.test`,
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

  try {
    const ownerId = await createUser("notification-preference-owner");
    const voterId = await createUser("notification-preference-voter");
    await createDevice(ownerId, "owner");

    const futureSubjectId = `gal_future_digest_${suffix}`;
    await db.$transaction((tx) => enqueueGalleryUpvotes(tx, {
      userId: ownerId,
      voterId,
      subjectId: futureSubjectId,
      createdAt: futureAt,
    }));
    const suppressedFuture = await db.notificationDelivery.findFirstOrThrow({
      where: { userId: ownerId, subjectId: futureSubjectId, kind: "gallery_upvotes" },
    });
    assert.equal(suppressedFuture.finishedAt, null);
    assert.ok(suppressedFuture.runAfter > new Date());

    await updateNotificationSettings(ownerId, { generations: true, upvotes: false, contributions: true });
    assert.ok((await db.notificationDelivery.findUniqueOrThrow({ where: { id: suppressedFuture.id } })).finishedAt);
    await updateNotificationSettings(ownerId, { generations: true, upvotes: true, contributions: true });
    await db.$transaction((tx) => enqueueGalleryUpvotes(tx, {
      userId: ownerId,
      voterId,
      subjectId: futureSubjectId,
      createdAt: new Date(futureAt.getTime() + 5 * 60_000),
    }));
    const reopenedFuture = await db.notificationDelivery.findUniqueOrThrow({ where: { id: suppressedFuture.id } });
    assert.equal(reopenedFuture.finishedAt, null);
    assert.equal(reopenedFuture.leaseToken, null);
    assert.equal(reopenedFuture.leaseExpiresAt, null);

    const pastSubjectId = `gal_past_digest_${suffix}`;
    await db.$transaction((tx) => enqueueGalleryUpvotes(tx, {
      userId: ownerId,
      voterId,
      subjectId: pastSubjectId,
      createdAt: futureAt,
    }));
    const sentPast = await db.notificationDelivery.findFirstOrThrow({
      where: { userId: ownerId, subjectId: pastSubjectId, kind: "gallery_upvotes" },
    });
    await db.notificationDelivery.update({
      where: { id: sentPast.id },
      data: { finishedAt: past, runAfter: past, leaseToken: "finished-lease", leaseExpiresAt: past },
    });
    await updateNotificationSettings(ownerId, { generations: true, upvotes: false, contributions: true });
    await updateNotificationSettings(ownerId, { generations: true, upvotes: true, contributions: true });
    await db.$transaction((tx) => enqueueGalleryUpvotes(tx, {
      userId: ownerId,
      voterId,
      subjectId: pastSubjectId,
      createdAt: new Date(futureAt.getTime() + 10 * 60_000),
    }));
    const retainedPast = await db.notificationDelivery.findUniqueOrThrow({ where: { id: sentPast.id } });
    assert.ok(retainedPast.finishedAt);
    assert.equal(retainedPast.leaseToken, "finished-lease");
    assert.equal(await db.notificationDelivery.count({ where: { userId: ownerId, subjectId: pastSubjectId, finishedAt: null } }), 0);

    console.log("notification preference PostgreSQL checks passed");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
