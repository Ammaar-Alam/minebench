import { randomUUID } from "node:crypto";
import { Prisma, type NotificationKind } from "@prisma/client";
import { z } from "zod";
import { AccountServiceError } from "@/lib/account/service";
import { prisma } from "@/lib/prisma";

export const notificationSettingsSchema = z.object({
  generations: z.boolean(),
  upvotes: z.boolean(),
  contributions: z.boolean(),
  email: z.boolean().optional(),
}).strict();

export const pushDeviceSchema = z.object({
  token: z.string().min(2).max(512).regex(/^(?:[0-9a-fA-F]{2})+$/).transform((token) => token.toLowerCase()),
  environment: z.enum(["development", "production"]),
}).strict();

export type NotificationSettings = Required<z.infer<typeof notificationSettingsSchema>>;
const settingsSelect = { generations: true, upvotes: true, contributions: true, email: true } as const;
const defaultSettings: NotificationSettings = { generations: true, upvotes: true, contributions: true, email: true };
export const NOTIFICATION_HOUR_MS = 60 * 60 * 1000;

export function pushNotificationsEnabled(): boolean {
  return process.env.APNS_ENABLED === "true";
}

export function emailNotificationsEnabled(): boolean {
  return process.env.EMAIL_NOTIFICATIONS_ENABLED === "true";
}

export function notificationsEnabled(): boolean {
  return pushNotificationsEnabled() || emailNotificationsEnabled();
}

export function notificationCategory(kind: NotificationKind): Exclude<keyof NotificationSettings, "email"> {
  return kind === "gallery_upvotes" ? "upvotes"
    : kind === "gallery_contribution" ? "contributions" : "generations";
}

export async function getNotificationSettings(userId: string) {
  const settings = await prisma.notificationPreference.findUnique({ where: { userId }, select: settingsSelect });
  return { settings: settings ?? defaultSettings, available: pushNotificationsEnabled() };
}

export async function lockNotificationAccounts(tx: Prisma.TransactionClient, userIds: Array<string | null | undefined>) {
  if (!notificationsEnabled()) return;
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))].sort();
  if (!ids.length) return;
  // match account deletion's account-first lock order before touching business rows
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM "User" WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      AND "deletedAt" IS NULL ORDER BY id FOR KEY SHARE
  `);
}

async function lockActiveAccount(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "User" WHERE id = ${userId}::uuid AND "deletedAt" IS NULL FOR UPDATE
  `;
  if (!rows.length) throw new AccountServiceError("not_found", "Account unavailable.");
}

export async function updateNotificationSettings(userId: string, settings: z.infer<typeof notificationSettingsSchema>) {
  const updated = await prisma.$transaction(async (tx) => {
    await lockActiveAccount(tx, userId);
    const preference = await tx.notificationPreference.upsert({
      where: { userId }, create: { userId, ...settings }, update: settings,
      select: settingsSelect,
    });
    const disabledKinds: NotificationKind[] = [
      ...(!settings.generations ? ["generation_succeeded", "generation_failed"] as const : []),
      ...(!settings.upvotes ? ["gallery_upvotes"] as const : []),
      ...(!settings.contributions ? ["gallery_contribution"] as const : []),
    ];
    await tx.notificationDelivery.updateMany({
      where: {
        userId, finishedAt: null,
        OR: [{ kind: { in: disabledKinds } }, ...(settings.email === false ? [{ deviceId: null }] : [])],
      },
      data: { finishedAt: new Date() },
    });
    return preference;
  });
  return { settings: updated, available: pushNotificationsEnabled() };
}

export async function registerPushDevice(userId: string, device: z.infer<typeof pushDeviceSchema>) {
  await prisma.$transaction(async (tx) => {
    await lockActiveAccount(tx, userId);
    const registered = await tx.pushDevice.upsert({
      where: { token_environment: device },
      create: { userId, ...device },
      update: { userId, updatedAt: new Date() },
    });
    await tx.notificationDelivery.deleteMany({ where: { deviceId: registered.id, userId: { not: userId } } });
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
  const account = await tx.user.findFirst({
    where: { id: event.userId, deletedAt: null },
    select: { notificationPreference: true },
  });
  if (!account || account.notificationPreference?.[notificationCategory(event.kind)] === false) return;
  const values = Prisma.sql`${event.userId}::uuid, ${event.kind}::"NotificationKind", ${event.subjectId}, ${event.eventKey},
    ${event.exampleId ?? null}, ${event.windowStart ?? null}::timestamp, ${event.runAfter ?? new Date()}::timestamp`;
  const reopenSummary = Prisma.sql`
    SET "finishedAt" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL
    WHERE "NotificationDelivery".kind = 'gallery_upvotes'::"NotificationKind"
      AND "NotificationDelivery"."finishedAt" IS NOT NULL
      AND "NotificationDelivery"."runAfter" > now()
  `;
  if (pushNotificationsEnabled()) {
    // hold registrations until enqueue commits so sign-out cannot race the foreign key
    await tx.$executeRaw(Prisma.sql`
      WITH devices AS (
        SELECT id FROM "PushDevice" WHERE "userId" = ${event.userId}::uuid FOR SHARE
      )
      INSERT INTO "NotificationDelivery"
        (id, "deviceId", "userId", kind, "subjectId", "eventKey", "exampleId", "windowStart", "runAfter")
      SELECT ${randomUUID()} || ':' || d.id, d.id, ${values} FROM devices d
      ON CONFLICT ("deviceId", "eventKey") DO UPDATE ${reopenSummary}
    `);
  }
  if (emailNotificationsEnabled() && account.notificationPreference?.email !== false) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "NotificationDelivery"
        (id, "deviceId", "userId", kind, "subjectId", "eventKey", "exampleId", "windowStart", "runAfter")
      VALUES (${randomUUID()}, NULL, ${values})
      ON CONFLICT ("userId", "eventKey") WHERE "deviceId" IS NULL DO UPDATE ${reopenSummary}
    `);
  }
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
