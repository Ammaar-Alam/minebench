import { randomUUID } from "node:crypto";
import type { NotificationKind, Prisma } from "@prisma/client";
import { z } from "zod";
import { AccountServiceError } from "@/lib/account/service";
import { prisma } from "@/lib/prisma";

export const notificationSettingsSchema = z.object({
  generations: z.boolean(),
  upvotes: z.boolean(),
  contributions: z.boolean(),
}).strict();

export const pushDeviceSchema = z.object({
  token: z.string().min(2).max(512).regex(/^(?:[0-9a-fA-F]{2})+$/).transform((token) => token.toLowerCase()),
  environment: z.enum(["development", "production"]),
}).strict();

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
const settingsSelect = { generations: true, upvotes: true, contributions: true } as const;
const defaultSettings: NotificationSettings = { generations: true, upvotes: true, contributions: true };
export const NOTIFICATION_HOUR_MS = 60 * 60 * 1000;

export function notificationsEnabled(): boolean {
  return process.env.APNS_ENABLED === "true";
}

export function notificationCategory(kind: NotificationKind): keyof NotificationSettings {
  return kind === "gallery_upvotes" ? "upvotes"
    : kind === "gallery_contribution" ? "contributions" : "generations";
}

export async function getNotificationSettings(userId: string) {
  const settings = await prisma.notificationPreference.findUnique({ where: { userId }, select: settingsSelect });
  return { settings: settings ?? defaultSettings, available: notificationsEnabled() };
}

async function lockActiveAccount(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "User" WHERE id = ${userId}::uuid AND "deletedAt" IS NULL FOR UPDATE
  `;
  if (!rows.length) throw new AccountServiceError("not_found", "Account unavailable.");
}

export async function updateNotificationSettings(userId: string, settings: NotificationSettings) {
  await prisma.$transaction(async (tx) => {
    await lockActiveAccount(tx, userId);
    await tx.notificationPreference.upsert({
      where: { userId }, create: { userId, ...settings }, update: settings,
    });
    const disabledKinds: NotificationKind[] = [
      ...(!settings.generations ? ["generation_succeeded", "generation_failed"] as const : []),
      ...(!settings.upvotes ? ["gallery_upvotes"] as const : []),
      ...(!settings.contributions ? ["gallery_contribution"] as const : []),
    ];
    await tx.pushDelivery.updateMany({
      where: { userId, finishedAt: null, kind: { in: disabledKinds } },
      data: { finishedAt: new Date() },
    });
  });
  return { settings, available: notificationsEnabled() };
}

export async function registerPushDevice(userId: string, device: z.infer<typeof pushDeviceSchema>) {
  await prisma.$transaction(async (tx) => {
    await lockActiveAccount(tx, userId);
    const registered = await tx.pushDevice.upsert({
      where: { token_environment: device },
      create: { userId, ...device },
      update: { userId, updatedAt: new Date() },
    });
    await tx.pushDelivery.deleteMany({ where: { deviceId: registered.id, userId: { not: userId } } });
    if (await tx.pushDevice.count({ where: { userId } }) > 20) {
      throw new AccountServiceError("device_limit_reached", "Too many registered devices.");
    }
  });
  return { registered: true };
}

export async function removePushDevice(userId: string, device: z.infer<typeof pushDeviceSchema>) {
  await prisma.pushDevice.deleteMany({ where: { userId, ...device } });
  return { removed: true };
}

async function enqueueNotification(tx: Prisma.TransactionClient, event: {
  userId: string;
  kind: NotificationKind;
  subjectId: string;
  eventKey: string;
  exampleId?: string;
  windowStart?: Date;
  runAfter?: Date;
}) {
  if (!notificationsEnabled()) return;
  // lock registrations until enqueue commits so sign-out cannot race the foreign key
  await tx.$executeRaw`
    WITH devices AS (
      SELECT d.id FROM "PushDevice" d
      JOIN "User" u ON u.id = d."userId"
      LEFT JOIN "NotificationPreference" p ON p."userId" = u.id
      WHERE d."userId" = ${event.userId}::uuid AND u."deletedAt" IS NULL
        AND COALESCE(CASE ${notificationCategory(event.kind)}
          WHEN 'upvotes' THEN p.upvotes
          WHEN 'contributions' THEN p.contributions
          ELSE p.generations END, true)
      FOR SHARE OF d
    )
    INSERT INTO "PushDelivery"
      (id, "deviceId", "userId", kind, "subjectId", "eventKey", "exampleId", "windowStart", "runAfter")
    SELECT ${randomUUID()} || ':' || d.id, d.id, ${event.userId}::uuid,
      ${event.kind}::"NotificationKind", ${event.subjectId}, ${event.eventKey},
      ${event.exampleId ?? null}, ${event.windowStart ?? null}::timestamp, ${event.runAfter ?? new Date()}::timestamp
    FROM devices d
    ON CONFLICT ("deviceId", "eventKey") DO NOTHING
  `;
}

export async function enqueueGenerationNotification(tx: Prisma.TransactionClient, customBuildId: string) {
  if (!notificationsEnabled()) return;
  const build = await tx.customBuild.findFirst({
    where: { id: customBuildId, removedAt: null, status: { in: ["succeeded", "failed"] } },
    select: { id: true, publicId: true, ownerId: true, status: true, completedAt: true },
  });
  if (!build?.ownerId || !build.completedAt) return;
  await enqueueNotification(tx, {
    userId: build.ownerId,
    kind: build.status === "succeeded" ? "generation_succeeded" : "generation_failed",
    subjectId: build.publicId,
    eventKey: `generation:${build.id}:${build.status}:${build.completedAt.getTime()}`,
  });
}

export async function enqueueGalleryContribution(tx: Prisma.TransactionClient, event: {
  userId: string; contributorId: string; subjectId: string; exampleId: string;
}) {
  if (event.userId === event.contributorId) return;
  await enqueueNotification(tx, {
    ...event, kind: "gallery_contribution", eventKey: `contribution:${event.exampleId}`,
  });
}

export async function enqueueGalleryUpvotes(tx: Prisma.TransactionClient, event: {
  userId: string; voterId: string | null; subjectId: string; createdAt: Date;
}) {
  if (event.userId === event.voterId) return;
  const windowStart = new Date(Math.floor(event.createdAt.getTime() / NOTIFICATION_HOUR_MS) * NOTIFICATION_HOUR_MS);
  await enqueueNotification(tx, {
    ...event, kind: "gallery_upvotes", windowStart,
    runAfter: new Date(windowStart.getTime() + NOTIFICATION_HOUR_MS),
    eventKey: `upvotes:${event.subjectId}:${windowStart.getTime()}`,
  });
}
