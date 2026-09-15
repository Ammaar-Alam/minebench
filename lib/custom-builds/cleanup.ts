import type { CustomBuildArtifact, Prisma } from "@prisma/client";
import { customBuildStorageBigInt } from "@/lib/custom-builds/numericMetadata";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import { deleteCustomBuildArtifacts } from "@/lib/custom-builds/storage";
import { prisma } from "@/lib/prisma";

export async function purgePendingCustomBuildArtifacts(options: {
  now?: Date;
  limit?: number;
  deleteArtifact?: (artifact: Pick<CustomBuildArtifact, "bucket" | "path">) => Promise<void>;
} = {}) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const eligibleWhere = {
    AND: [
      { OR: [
        { deletionPendingAt: { not: null } },
        { removedAt: { not: null }, purgeAt: { lte: now }, artifacts: { some: {} } },
      ] },
      { OR: [
        { removedAt: { not: null } },
        { status: "canceled" },
        { status: "failed", OR: [{ errorRetryable: false }, { errorRetryable: null }] },
      ] },
    ],
  } satisfies Prisma.CustomBuildWhereInput;
  const pendingBuilds = await prisma.customBuild.findMany({
    where: eligibleWhere,
    orderBy: [{ purgeAt: "asc" }, { removedAt: "asc" }],
    take: limit,
    select: { id: true },
  });

  let objectsDeleted = 0;
  let objectDeletionFailures = 0;
  for (const build of pendingBuilds) {
    try {
      const current = await prisma.customBuild.findFirst({
        where: { id: build.id, ...eligibleWhere },
        select: { galleryExamples: {
          where: { previewRetained: true, purgeAt: { gt: now } },
          select: { id: true },
          take: 1,
        } },
      });
      if (!current) continue;
      const retainPreview = current.galleryExamples.length > 0;
      const artifacts = await prisma.customBuildArtifact.findMany({
        where: { customBuildId: build.id, ...(retainPreview ? { kind: { not: "preview_svg" as const } } : {}) },
        select: { id: true, bucket: true, path: true },
      });
      if (options.deleteArtifact) {
        for (const artifact of artifacts) await options.deleteArtifact(artifact);
      } else {
        await deleteCustomBuildArtifacts(artifacts);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "CustomBuild" WHERE id = ${build.id} FOR UPDATE`;
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
            storedByteSize: customBuildStorageBigInt(remaining._sum.storedByteSize),
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
  return { objectsDeleted, objectDeletionFailures };
}

export function startCustomBuildCleanup(): () => Promise<void> {
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (active) return;
    active = purgePendingCustomBuildArtifacts().catch((error) => {
      console.warn("Custom build cleanup unavailable:", redactSensitiveText(error));
    }).finally(() => { active = undefined; });
  };
  tick();
  const timer = setInterval(tick, 5_000);
  return async () => {
    clearInterval(timer);
    await active;
  };
}
