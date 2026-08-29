import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PublicAccount } from "@/lib/auth/account";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import { prisma } from "@/lib/prisma";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const DEFAULT_AUTH_DELETION_BATCH_SIZE = 100;

export class AccountServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AccountServiceError";
  }
}

export function serializeAccount(account: PublicAccount) {
  const remaining = Math.max(0, account.hostedGenerationLimit - account.hostedGenerationCount);
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    publicNickname: account.publicNickname,
    createdAt: account.createdAt.toISOString(),
    gallerySuspension: account.gallerySuspendedAt
      ? {
          suspendedAt: account.gallerySuspendedAt.toISOString(),
          reason: account.gallerySuspensionReason,
        }
      : null,
    hostedGeneration: {
      used: account.hostedGenerationCount,
      limit: account.hostedGenerationLimit,
      remaining,
      available: remaining > 0 && Boolean(process.env.MINEBENCH_FREE_OPENROUTER_API_KEY?.trim()),
    },
  };
}

async function deleteSupabaseAuthUser(userId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().auth.admin.deleteUser(userId);
  if (error) throw error;
}

async function markAuthDeleted(userId: string, now: Date): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, deletedAt: { not: null }, authDeletedAt: null },
    data: { authDeletedAt: now },
  });
}

export async function deleteMineBenchAccount(
  userId: string,
  options: {
    now?: Date;
    deleteAuthUser?: (userId: string) => Promise<void>;
  } = {},
) {
  const now = options.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    const [account] = await tx.$queryRaw<Array<{ id: string; email: string }>>(Prisma.sql`
      SELECT id, email
      FROM "User"
      WHERE id = ${userId}::uuid
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (!account) throw new AccountServiceError("not_found", "Account not found.");

    const retainedBuilds = await tx.customBuild.findMany({
      where: {
        ownerId: userId,
        status: "succeeded",
        galleryExamples: {
          some: {
            removedAt: null,
            adminHiddenAt: null,
            candidate: { removedAt: null, adminHiddenAt: null },
          },
        },
      },
      select: { id: true },
    });
    const retainedBuildIds = retainedBuilds.map(({ id }) => id);
    const nonRetainedBuildWhere = {
      ownerId: userId,
      ...(retainedBuildIds.length > 0 ? { id: { notIn: retainedBuildIds } } : {}),
    };

    await tx.customBuildSecret.deleteMany({ where: { customBuild: { ownerId: userId } } });
    await tx.customBuildJob.updateMany({
      where: {
        customBuild: nonRetainedBuildWhere,
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "canceled",
        completedAt: now,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    await tx.customBuild.updateMany({
      where: {
        ...nonRetainedBuildWhere,
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "canceled",
        currentStage: "canceled",
        completedAt: now,
        errorCode: "account_deleted",
        errorMessage: "Account deleted.",
        errorRetryable: false,
      },
    });
    await tx.galleryExample.updateMany({
      where: {
        customBuild: nonRetainedBuildWhere,
      },
      data: {
        postAnonymously: true,
        removedAt: now,
        purgeAt: now,
        previewRetained: false,
      },
    });
    await tx.customBuild.updateMany({
      where: nonRetainedBuildWhere,
      data: {
        requestedIpHash: null,
        requestedUserAgentHash: null,
        removedAt: now,
        purgeAt: now,
        objectsDeletedAt: null,
        deletionPendingAt: now,
        deletionError: null,
      },
    });

    if (retainedBuildIds.length > 0) {
      await tx.customBuildJob.deleteMany({
        where: { customBuildId: { in: retainedBuildIds } },
      });
      await tx.customBuildEvent.deleteMany({
        where: { customBuildId: { in: retainedBuildIds } },
      });
      await tx.customBuild.updateMany({
        where: { id: { in: retainedBuildIds }, ownerId: userId },
        data: {
          requestedIpHash: null,
          requestedUserAgentHash: null,
        },
      });
    }

    await tx.galleryCandidate.updateMany({
      where: { uploaderId: userId },
      data: { postAnonymously: true },
    });
    await tx.galleryCandidate.updateMany({
      where: { selectedById: userId },
      data: { selectedById: null },
    });
    await tx.galleryExample.updateMany({
      where: { contributorId: userId },
      data: { postAnonymously: true },
    });

    await tx.$executeRaw(Prisma.sql`
      UPDATE "Vote"
      SET "userId" = NULL,
          "sessionId" = gen_random_uuid()::text
      WHERE "userId" = ${userId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "GalleryVote"
      SET "userId" = NULL,
          "sessionId" = gen_random_uuid()::text
      WHERE "userId" = ${userId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "PublicSessionActivity"
      SET "userId" = NULL,
          "sessionId" = gen_random_uuid()::text,
          city = NULL,
          "countryRegion" = NULL,
          country = NULL,
          "ipHmac" = NULL
      WHERE "userId" = ${userId}::uuid
    `);

    await tx.galleryModerationRecord.updateMany({
      where: { OR: [{ actorUserId: userId }, { subjectUserId: userId }] },
      data: {
        note: null,
        safeSnapshot: Prisma.DbNull,
        sessionHash: null,
        ipHmac: null,
      },
    });
    await tx.galleryModerationRecord.updateMany({
      where: { actorUserId: userId },
      data: { actorUserId: null },
    });
    await tx.galleryModerationRecord.updateMany({
      where: { subjectUserId: userId },
      data: { subjectUserId: null },
    });
    await tx.galleryVoteBlock.deleteMany({ where: { userId } });
    await tx.galleryVoteBlock.updateMany({
      where: { reversedById: userId },
      data: { reversedById: null },
    });
    await tx.user.updateMany({
      where: { gallerySuspendedById: userId },
      data: { gallerySuspendedById: null },
    });

    await tx.organizationMembership.deleteMany({ where: { userId } });
    await tx.organizationInvitation.deleteMany({
      where: {
        OR: [
          { authUserId: userId },
          { acceptedById: userId },
          { email: { equals: account.email, mode: "insensitive" } },
        ],
      },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        email: `${randomUUID()}@deleted.minebench.invalid`,
        displayName: null,
        publicNickname: null,
        publicNicknameNormalized: null,
        lastSeenAt: null,
        isMineBenchAdmin: false,
        gallerySuspendedAt: null,
        gallerySuspensionReason: null,
        gallerySuspendedById: null,
        galleryRestoredAt: null,
        totalGenerationCount: 0,
        hostedGenerationCount: 0,
        hostedGenerationLimit: 0,
        deletedAt: now,
        authDeletedAt: null,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  try {
    await (options.deleteAuthUser ?? deleteSupabaseAuthUser)(userId);
    await markAuthDeleted(userId, now);
  } catch (error) {
    console.error("Supabase Auth account deletion pending", redactSensitiveText(error));
  }
  return { deleted: true } as const;
}

export async function retryPendingAuthDeletions(
  options: {
    now?: Date;
    limit?: number;
    deleteAuthUser?: (userId: string) => Promise<void>;
  } = {},
) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_AUTH_DELETION_BATCH_SIZE, 500));
  const pending = await prisma.user.findMany({
    where: { deletedAt: { not: null }, authDeletedAt: null },
    orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  let deleted = 0;
  let failures = 0;
  for (const account of pending) {
    try {
      await (options.deleteAuthUser ?? deleteSupabaseAuthUser)(account.id);
      await markAuthDeleted(account.id, now);
      deleted += 1;
    } catch (error) {
      failures += 1;
      console.error("Supabase Auth account deletion retry failed", redactSensitiveText(error));
    }
  }
  return { deleted, failures };
}
