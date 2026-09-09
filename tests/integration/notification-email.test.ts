import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { sendMineBenchEmail } from "../../lib/contactEmail";

process.env.APNS_ENABLED = "false";
process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
process.env.MINEBENCH_ENVIRONMENT = "production";
process.env.MINEBENCH_SITE_URL = "https://minebench.ai";
delete process.env.NOTIFICATION_EMAIL_TEST_RECIPIENT;
delete process.env.CONTACT_SMTP_PASSWORD;

const db = new PrismaClient();

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) return;
  const { enqueueGenerationNotification, enqueueGalleryUpvotes, getNotificationSettings, registerPushDevice,
    updateNotificationSettings, NOTIFICATION_HOUR_MS } = await import("../../lib/notifications/service");
  const { drainNotifications } = await import("../../lib/notifications/delivery");
  const { deleteMineBenchAccount } = await import("../../lib/account/service");
  const userId = randomUUID();
  const email = `notifications-${userId}@example.test`;
  const messages: Parameters<typeof sendMineBenchEmail>[0][] = [];
  const sendEmail: typeof sendMineBenchEmail = async (message) => { messages.push(message); };
  let pushes = 0;
  const sendPush = async () => { pushes += 1; return { status: 200 }; };
  const enabled = { generations: true, upvotes: true, contributions: true, email: true };
  const due = new Date(Date.now() - 1_000);

  try {
    await db.user.create({ data: { id: userId, email } });
    const build = await db.customBuild.create({ data: {
      publicId: `cb_email_${userId}`, ownerId: userId,
      status: "succeeded", currentStage: "succeeded", completedAt: due,
      promptText: "Email notification fixture", promptSha256: "a".repeat(64),
      gridSize: 64, palette: "simple", modelKind: "catalog", modelProvider: "openai",
      modelId: "gpt-5.4-mini", modelDisplayName: "GPT 5.4 Mini",
    } });
    const enqueue = () => db.$transaction(async (tx) => {
      await enqueueGenerationNotification(tx, build.id);
      await tx.notificationDelivery.updateMany({ where: { userId, finishedAt: null }, data: { runAfter: due } });
    });
    const reset = async () => {
      await db.notificationDelivery.deleteMany({ where: { userId } });
      messages.length = 0;
      pushes = 0;
    };

    assert.deepEqual(await getNotificationSettings(userId), { settings: enabled, available: false });
    await Promise.all([enqueue(), enqueue()]);
    assert.equal(await db.notificationDelivery.count({ where: { userId } }), 1, "email deduplicates without any registered device");
    assert.equal((await db.notificationDelivery.findFirstOrThrow({ where: { userId } })).deviceId, null);
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, email);
    assert.ok(messages[0].html.includes(`/account?generation=${build.publicId}`));
    assert.ok(messages[0].html.includes("Manage notifications"));
    assert.equal(pushes, 0);
    await enqueue();
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 1, "finished emails are not re-sent");

    await reset();
    await enqueue();
    let attempts = 0;
    const temporaryFailure: typeof sendMineBenchEmail = async (message) => {
      messages.push(message);
      if (attempts++ === 0) throw Object.assign(new Error("temporary SMTP failure"), { responseCode: 451 });
    };
    await drainNotifications(sendPush, temporaryFailure);
    const retry = await db.notificationDelivery.findFirstOrThrow({ where: { userId } });
    assert.equal(retry.finishedAt, null);
    assert.equal(retry.attempts, 1);
    assert.ok(retry.runAfter > new Date());
    await db.notificationDelivery.update({ where: { id: retry.id }, data: { runAfter: due } });
    await drainNotifications(sendPush, temporaryFailure);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].messageId, messages[1].messageId);
    assert.ok((await db.notificationDelivery.findUniqueOrThrow({ where: { id: retry.id } })).finishedAt);

    await reset();
    await enqueue();
    await drainNotifications(sendPush, async () => { throw Object.assign(new Error("rejected recipient"), { responseCode: 550 }); });
    assert.ok((await db.notificationDelivery.findFirstOrThrow({ where: { userId } })).finishedAt, "permanent SMTP failures finish immediately");

    await reset();
    process.env.APNS_ENABLED = "true";
    await registerPushDevice(userId, { token: "ab".repeat(32), environment: "development" });
    await enqueue();
    assert.equal(await db.notificationDelivery.count({ where: { userId } }), 2);
    await updateNotificationSettings(userId, { ...enabled, email: false });
    await updateNotificationSettings(userId, { generations: true, upvotes: true, contributions: true });
    assert.equal((await getNotificationSettings(userId)).settings.email, false, "native settings writes preserve email opt-out");
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 0);
    assert.equal(pushes, 1, "email opt-out leaves push delivery enabled");

    await reset();
    await updateNotificationSettings(userId, enabled);
    await enqueue();
    await updateNotificationSettings(userId, { ...enabled, generations: false });
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 0);
    assert.equal(pushes, 0, "category opt-out cancels both channels");
    await updateNotificationSettings(userId, enabled);

    await reset();
    process.env.APNS_ENABLED = "false";
    const future = new Date(Math.floor(Date.now() / NOTIFICATION_HOUR_MS) * NOTIFICATION_HOUR_MS + 2 * NOTIFICATION_HOUR_MS);
    const upvote = () => db.$transaction((tx) => enqueueGalleryUpvotes(tx, {
      userId, voterId: null, subjectId: `gal_email_${userId}`, createdAt: future,
    }));
    await upvote();
    await upvote();
    const digest = await db.notificationDelivery.findFirstOrThrow({ where: { userId } });
    assert.equal(await db.notificationDelivery.count({ where: { userId } }), 1, "email upvotes share the hourly digest");
    await updateNotificationSettings(userId, { ...enabled, email: false });
    await updateNotificationSettings(userId, enabled);
    await upvote();
    assert.equal((await db.notificationDelivery.findUniqueOrThrow({ where: { id: digest.id } })).finishedAt, null);

    await reset();
    await enqueue();
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 0);
    assert.equal((await db.notificationDelivery.findFirstOrThrow({ where: { userId } })).attempts, 0);
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
    process.env.MINEBENCH_ENVIRONMENT = "alpha";
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 0, "Alpha must not email copied production accounts");

    await reset();
    process.env.NOTIFICATION_EMAIL_TEST_RECIPIENT = email;
    await enqueue();
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 1, "Alpha allows only the configured test recipient");

    await reset();
    await enqueue();
    await db.customBuild.update({ where: { id: build.id }, data: { status: "running", completedAt: null } });
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 0, "a restarted generation suppresses its previous completion email");

    await reset();
    await db.customBuild.update({ where: { id: build.id }, data: { status: "succeeded", completedAt: due } });
    process.env.APNS_ENABLED = "true";
    await enqueue();
    assert.equal(await db.notificationDelivery.count({ where: { userId } }), 2);
    await deleteMineBenchAccount(userId, { deleteAuthUser: async () => {} });
    assert.equal(await db.notificationDelivery.count({ where: { userId } }), 0);
    assert.equal(await db.pushDevice.count({ where: { userId } }), 0);
    assert.equal(await db.notificationPreference.count({ where: { userId } }), 0);
    await drainNotifications(sendPush, sendEmail);
    assert.equal(messages.length, 0);
    assert.equal(pushes, 0);
    console.log("notification email PostgreSQL checks passed");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
