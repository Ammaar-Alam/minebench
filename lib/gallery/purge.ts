import type { CustomBuildArtifact } from "@prisma/client";
import { retryPendingAuthDeletions } from "@/lib/account/service";
import { purgePendingCustomBuildArtifacts } from "@/lib/custom-builds/cleanup";
import { prisma } from "@/lib/prisma";
import { PUBLIC_SESSION_RETENTION_MS } from "@/lib/publicPresence";

const DEFAULT_BATCH_SIZE = 100;

type PurgeAuthorization = { minebenchAdmin: true };
type DeleteArtifact = (artifact: Pick<CustomBuildArtifact, "bucket" | "path">) => Promise<void>;

export async function purgeDueGalleryRecords(
  authorization: PurgeAuthorization,
  options: {
    now?: Date;
    limit?: number;
    deleteArtifact?: DeleteArtifact;
    deleteAuthUser?: (userId: string) => Promise<void>;
  } = {},
) {
  if (authorization.minebenchAdmin !== true) throw new Error("Gallery purge authorization is required");
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_BATCH_SIZE, 500));

  const authUsers = await retryPendingAuthDeletions({
    now,
    limit,
    ...(options.deleteAuthUser ? { deleteAuthUser: options.deleteAuthUser } : {}),
  });

  const expiredSecrets = await prisma.customBuildSecret.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  const { objectsDeleted, objectDeletionFailures } = await purgePendingCustomBuildArtifacts({
    now, limit, deleteArtifact: options.deleteArtifact,
  });

  const moderationIds = await prisma.galleryModerationRecord.findMany({
    where: { purgeAt: { lte: now } },
    orderBy: [{ purgeAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });
  const moderationRecords = await prisma.galleryModerationRecord.deleteMany({
    where: { id: { in: moderationIds.map(({ id }) => id) } },
  });

  const publicSessions = await prisma.publicSessionActivity.deleteMany({
    where: { lastSeenAt: { lte: new Date(now.getTime() - PUBLIC_SESSION_RETENTION_MS) } },
  });

  const exampleIds = await prisma.galleryExample.findMany({
    where: { purgeAt: { lte: now } },
    orderBy: [{ purgeAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });
  const examples = await prisma.galleryExample.deleteMany({
    where: { id: { in: exampleIds.map(({ id }) => id) } },
  });

  const candidateIds = await prisma.galleryCandidate.findMany({
    where: {
      OR: [{ removedAt: { not: null } }, { adminHiddenAt: { not: null } }],
      purgeAt: { lte: now },
      selectedAt: null,
      officialPromptId: null,
    },
    orderBy: [{ purgeAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });
  const candidates = await prisma.galleryCandidate.deleteMany({
    where: {
      id: { in: candidateIds.map(({ id }) => id) },
      OR: [{ removedAt: { not: null } }, { adminHiddenAt: { not: null } }],
      purgeAt: { lte: now },
      selectedAt: null,
      officialPromptId: null,
    },
  });

  const generationIds = await prisma.customBuild.findMany({
    where: {
      removedAt: { not: null },
      purgeAt: { lte: now },
      deletionPendingAt: null,
      artifacts: { none: {} },
      galleryExamples: { none: {} },
    },
    orderBy: [{ purgeAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });
  const generations = await prisma.customBuild.deleteMany({
    where: { id: { in: generationIds.map(({ id }) => id) } },
  });

  return {
    authUsersDeleted: authUsers.deleted,
    authDeletionFailures: authUsers.failures,
    expiredSecrets: expiredSecrets.count,
    objectsDeleted,
    objectDeletionFailures,
    moderationRecords: moderationRecords.count,
    publicSessions: publicSessions.count,
    examples: examples.count,
    candidates: candidates.count,
    generations: generations.count,
  };
}
