import { createHash, randomUUID } from "node:crypto";
import type { PushDelivery } from "@prisma/client";
import { publicCandidateWhere, publicExampleWhere } from "@/lib/gallery/service";
import { closeApnsConnections, sendApnsNotification, type PushPayload } from "@/lib/notifications/apns";
import { notificationCategory, notificationsEnabled, NOTIFICATION_HOUR_MS } from "@/lib/notifications/service";
import { prisma } from "@/lib/prisma";

const MAX_ATTEMPTS = 6;
let lastPrunedAt = 0;

export async function claimPushDeliveries(): Promise<PushDelivery[]> {
  return prisma.$queryRaw<PushDelivery[]>`
    WITH pending AS (
      SELECT id FROM "PushDelivery"
      WHERE "finishedAt" IS NULL AND "runAfter" <= now()
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
        AND attempts < ${MAX_ATTEMPTS}
        AND "createdAt" > now() - interval '24 hours'
      ORDER BY "runAfter", id
      FOR UPDATE SKIP LOCKED LIMIT 10
    )
    UPDATE "PushDelivery" d
    SET "leaseToken" = ${randomUUID()}, "leaseExpiresAt" = now() + interval '90 seconds',
      attempts = attempts + 1
    FROM pending WHERE d.id = pending.id RETURNING d.*
  `;
}

async function notificationPayload(delivery: PushDelivery): Promise<PushPayload | null> {
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

async function deliverNotification(delivery: PushDelivery, send: typeof sendApnsNotification) {
  const claim = { id: delivery.id, leaseToken: delivery.leaseToken, finishedAt: null };
  let retry = false;
  try {
    const device = await prisma.pushDevice.findFirst({
      where: { id: delivery.deviceId, userId: delivery.userId, user: { deletedAt: null } },
      include: { user: { select: { notificationPreference: true } } },
    });
    const preference = device?.user.notificationPreference;
    const payload = device && preference?.[notificationCategory(delivery.kind)] !== false
      ? await notificationPayload(delivery) : null;
    if (device && payload && notificationsEnabled() && await prisma.pushDelivery.count({ where: claim })) {
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
  } catch {
    retry = true;
    console.warn("Push delivery failed");
  }
  await prisma.pushDelivery.updateMany({
    where: claim,
    data: {
      ...(retry && delivery.attempts < MAX_ATTEMPTS
        ? { runAfter: new Date(Date.now() + 30_000 * 2 ** (delivery.attempts - 1)) }
        : { finishedAt: new Date() }),
      leaseToken: null, leaseExpiresAt: null,
    },
  });
}

export async function drainPushNotifications(send = sendApnsNotification): Promise<void> {
  if (!notificationsEnabled()) return;
  if (Date.now() - lastPrunedAt >= NOTIFICATION_HOUR_MS) {
    await prisma.pushDelivery.updateMany({
      where: {
        finishedAt: null,
        OR: [{ createdAt: { lt: new Date(Date.now() - 24 * NOTIFICATION_HOUR_MS) } },
          { attempts: { gte: MAX_ATTEMPTS }, leaseExpiresAt: { lt: new Date() } }],
      },
      data: { finishedAt: new Date(), leaseToken: null, leaseExpiresAt: null },
    });
    const removed = await prisma.$executeRaw`
      DELETE FROM "PushDelivery" WHERE id IN (
        SELECT id FROM "PushDelivery" WHERE "createdAt" < now() - interval '7 days'
        ORDER BY "createdAt" LIMIT 1000
      )
    `;
    lastPrunedAt = removed === 1000 ? 0 : Date.now();
  }
  const results = await Promise.allSettled((await claimPushDeliveries()).map((delivery) => deliverNotification(delivery, send)));
  if (results.some((result) => result.status === "rejected")) console.warn("Push delivery bookkeeping failed");
}

export function startPushNotificationDelivery(): () => Promise<void> {
  let active: Promise<void> | undefined;
  const tick = () => {
    if (active) return;
    active = drainPushNotifications().catch(() => {
      console.warn("Push notification queue unavailable");
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
