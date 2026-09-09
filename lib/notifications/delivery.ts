import { createHash, randomUUID } from "node:crypto";
import type { NotificationDelivery } from "@prisma/client";
import { sendMineBenchEmail } from "@/lib/contactEmail";
import { publicCandidateWhere, publicExampleWhere } from "@/lib/gallery/service";
import { closeApnsConnections, sendApnsNotification, type PushPayload } from "@/lib/notifications/apns";
import { notificationEmailRecipientAllowed, renderNotificationEmail } from "@/lib/notifications/email";
import { emailNotificationsEnabled, notificationCategory, notificationsEnabled, pushNotificationsEnabled, NOTIFICATION_HOUR_MS } from "@/lib/notifications/service";
import { prisma } from "@/lib/prisma";

const MAX_ATTEMPTS = 6;
let lastPrunedAt = 0;

export async function claimNotificationDeliveries(): Promise<NotificationDelivery[]> {
  return prisma.$queryRaw<NotificationDelivery[]>`
    WITH pending AS (
      SELECT id FROM "NotificationDelivery"
      WHERE "finishedAt" IS NULL AND "runAfter" <= now()
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
        AND attempts < ${MAX_ATTEMPTS}
        AND "createdAt" > now() - interval '24 hours'
        AND (("deviceId" IS NULL AND ${emailNotificationsEnabled()})
          OR ("deviceId" IS NOT NULL AND ${pushNotificationsEnabled()}))
      ORDER BY "runAfter", id
      FOR UPDATE SKIP LOCKED LIMIT 10
    )
    UPDATE "NotificationDelivery" d
    SET "leaseToken" = ${randomUUID()}, "leaseExpiresAt" = now() + interval '90 seconds',
      attempts = attempts + 1
    FROM pending WHERE d.id = pending.id RETURNING d.*
  `;
}

async function notificationPayload(delivery: NotificationDelivery): Promise<PushPayload | null> {
  let title: string;
  let body: string;
  if (delivery.kind === "generation_succeeded" || delivery.kind === "generation_failed") {
    const status = delivery.kind === "generation_succeeded" ? "succeeded" : "failed";
    const build = await prisma.customBuild.findFirst({
      where: { publicId: delivery.subjectId, ownerId: delivery.userId, removedAt: null, status },
      select: { id: true, completedAt: true },
    });
    if (!build?.completedAt || delivery.eventKey !== `generation:${build.id}:${status}:${build.completedAt.getTime()}`) return null;
    title = status === "succeeded" ? "Build ready" : "Generation failed";
    body = status === "succeeded" ? "Your build is ready to explore." : "Your build couldn't be completed.";
  } else {
    const candidate = await prisma.galleryCandidate.findFirst({
      where: { publicId: delivery.subjectId, uploaderId: delivery.userId, ...publicCandidateWhere },
      select: { id: true },
    });
    if (!candidate) return null;
    if (delivery.kind === "gallery_contribution") {
      if (!delivery.exampleId || !await prisma.galleryExample.findFirst({
        where: {
          id: delivery.exampleId, candidateId: candidate.id,
          contributorId: { not: delivery.userId }, ...publicExampleWhere,
        },
        select: { id: true },
      })) return null;
      title = "New contribution";
      body = "Someone shared a new build for your prompt.";
    } else {
      if (!delivery.windowStart) return null;
      const count = await prisma.galleryVote.count({
        where: {
          candidateId: candidate.id,
          createdAt: { gte: delivery.windowStart, lt: new Date(delivery.windowStart.getTime() + NOTIFICATION_HOUR_MS) },
          OR: [{ userId: null }, { userId: { not: delivery.userId } }],
        },
      });
      if (!count) return null;
      title = count === 1 ? "New upvote" : "New upvotes";
      body = `Your prompt received ${count} new ${count === 1 ? "upvote" : "upvotes"}.`;
    }
  }
  return {
    aps: { alert: { title, body }, sound: "default", "thread-id": `${notificationCategory(delivery.kind)}:${delivery.subjectId}` },
    kind: delivery.kind, id: delivery.subjectId, userId: delivery.userId,
  };
}

async function deliverNotification(delivery: NotificationDelivery, send: typeof sendApnsNotification, sendEmail: typeof sendMineBenchEmail) {
  const claim = { id: delivery.id, leaseToken: delivery.leaseToken, finishedAt: null };
  let retry = false;
  try {
    const account = await prisma.user.findFirst({
      where: { id: delivery.userId, deletedAt: null },
      select: { email: true, notificationPreference: true },
    });
    const preference = account?.notificationPreference;
    const payload = account && preference?.[notificationCategory(delivery.kind)] !== false
      ? await notificationPayload(delivery) : null;
    const device = delivery.deviceId && await prisma.pushDevice.findFirst({
      where: { id: delivery.deviceId, userId: delivery.userId, user: { deletedAt: null } },
    });
    if (account && payload && !delivery.deviceId && preference?.email !== false && emailNotificationsEnabled()
      && notificationEmailRecipientAllowed(account.email) && await prisma.notificationDelivery.count({ where: claim })) {
      await sendEmail({
        to: account.email,
        messageId: `<${createHash("sha256").update(delivery.id).digest("hex")}@minebench.ai>`,
        ...renderNotificationEmail(payload),
      });
    } else if (device && payload && pushNotificationsEnabled() && await prisma.notificationDelivery.count({ where: claim })) {
      const result = await send({
        token: device.token, environment: device.environment, payload,
        collapseId: createHash("sha256").update(delivery.eventKey).digest("hex"),
      });
      const invalidToken = result.status === 400 && result.reason === "BadDeviceToken";
      const unregistered = result.status === 410 && result.reason === "Unregistered"
        && result.invalidatedAt !== undefined && device.updatedAt.getTime() <= result.invalidatedAt;
      if (invalidToken || unregistered) {
        await prisma.pushDevice.deleteMany({
          where: { id: device.id, userId: delivery.userId, token: device.token, environment: device.environment, updatedAt: device.updatedAt },
        });
      }
      retry = result.status === 429 || result.status === 403 || result.status >= 500;
      if (result.status !== 200) console.warn("Push delivery rejected", { status: result.status });
    }
  } catch (error) {
    const responseCode = error && typeof error === "object" && "responseCode" in error ? Number(error.responseCode) : 0;
    retry = !(responseCode >= 500 && responseCode < 600);
    console.warn("Notification delivery failed");
  }
  await prisma.notificationDelivery.updateMany({
    where: claim,
    data: {
      ...(retry && delivery.attempts < MAX_ATTEMPTS
        ? { runAfter: new Date(Date.now() + 30_000 * 2 ** (delivery.attempts - 1)) }
        : { finishedAt: new Date() }),
      leaseToken: null, leaseExpiresAt: null,
    },
  });
}

export async function drainNotifications(send = sendApnsNotification, sendEmail = sendMineBenchEmail): Promise<void> {
  if (!notificationsEnabled()) return;
  if (Date.now() - lastPrunedAt >= NOTIFICATION_HOUR_MS) {
    await prisma.notificationDelivery.updateMany({
      where: {
        finishedAt: null,
        OR: [{ createdAt: { lt: new Date(Date.now() - 24 * NOTIFICATION_HOUR_MS) } },
          { attempts: { gte: MAX_ATTEMPTS }, leaseExpiresAt: { lt: new Date() } }],
      },
      data: { finishedAt: new Date(), leaseToken: null, leaseExpiresAt: null },
    });
    const removed = await prisma.$executeRaw`
      DELETE FROM "NotificationDelivery" WHERE id IN (
        SELECT id FROM "NotificationDelivery" WHERE "createdAt" < now() - interval '7 days'
        ORDER BY "createdAt" LIMIT 1000
      )
    `;
    lastPrunedAt = removed === 1000 ? 0 : Date.now();
  }
  const results = await Promise.allSettled((await claimNotificationDeliveries()).map((delivery) => deliverNotification(delivery, send, sendEmail)));
  if (results.some((result) => result.status === "rejected")) console.warn("Notification delivery bookkeeping failed");
}

export function startNotificationDelivery(): () => Promise<void> {
  let active: Promise<void> | undefined;
  const tick = () => {
    if (active) return;
    active = drainNotifications().catch(() => {
      console.warn("Notification queue unavailable");
    }).finally(() => { active = undefined; });
  };
  tick();
  const timer = setInterval(tick, 5_000);
  return async () => {
    clearInterval(timer);
    await active;
    closeApnsConnections();
  };
}
