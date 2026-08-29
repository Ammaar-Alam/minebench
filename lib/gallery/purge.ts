import type { CustomBuildArtifact } from "@prisma/client";
import { retryPendingAuthDeletions } from "@/lib/account/service";
import { deleteCustomBuildArtifact } from "@/lib/custom-builds/storage";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
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
  const removeObject = options.deleteArtifact ?? deleteCustomBuildArtifact;

  const authUsers = await retryPendingAuthDeletions({
    now,
    limit,
    ...(options.deleteAuthUser ? { deleteAuthUser: options.deleteAuthUser } : {}),
  });

  const expiredSecrets = await prisma.customBuildSecret.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  const pendingBuilds = await prisma.customBuild.findMany({
    where: {
      OR: [
        { deletionPendingAt: { not: null } },
        { removedAt: { not: null }, purgeAt: { lte: now } },
      ],
    },
    orderBy: [{ purgeAt: "asc" }, { removedAt: "asc" }],
    take: limit,
    select: {
      id: true,
      galleryExamples: {
        where: { previewRetained: true, purgeAt: { gt: now } },
        select: { id: true },
      },
      artifacts: { select: { id: true, kind: true, bucket: true, path: true } },
    },
  });

  let objectsDeleted = 0;
  let objectDeletionFailures = 0;
  for (const build of pendingBuilds) {
    const retainPreview = build.galleryExamples.length > 0;
    const artifacts = retainPreview
      ? build.artifacts.filter((artifact) => artifact.kind !== "preview_svg")
      : build.artifacts;
    try {
      for (const artifact of artifacts) {
        await removeObject(artifact);
      }
      await prisma.$transaction(async (tx) => {
        await tx.customBuildArtifact.deleteMany({
          where: { id: { in: artifacts.map((artifact) => artifact.id) } },
        });
        const remaining = await tx.customBuildArtifact.aggregate({
          where: { customBuildId: build.id },
          _sum: { storedByteSize: true },
          _count: true,
        });
        const cleanupPending = retainPreview
          ? (await tx.customBuildArtifact.count({
              where: { customBuildId: build.id, kind: { not: "preview_svg" } },
            })) > 0
          : remaining._count > 0;
        await tx.customBuild.update({
          where: { id: build.id },
          data: {
            storedByteSize: remaining._sum.storedByteSize ?? 0,
            objectsDeletedAt: cleanupPending ? null : now,
            deletionPendingAt: cleanupPending ? now : null,
            deletionError: cleanupPending ? "Artifact cleanup pending." : null,
          },
        });
      });
      objectsDeleted += artifacts.length;
    } catch (error) {
      objectDeletionFailures += 1;
      await prisma.customBuild.update({
        where: { id: build.id },
        data: {
          deletionPendingAt: now,
          deletionError: redactSensitiveText(error).slice(0, 500),
        },
      });
    }
  }

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
