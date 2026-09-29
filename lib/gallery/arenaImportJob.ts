import { Prisma, type CustomBuildJob } from "@prisma/client";
import { invalidateArenaBuildMeta } from "@/lib/arena/buildMetaCache";
import { deleteCustomBuildArtifact } from "@/lib/custom-builds/storage";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import { deleteRetiredGalleryArenaArtifacts } from "@/lib/gallery/arenaImport";
import { maybePrecomputeArenaArtifactsForBuild } from "@/lib/arena/artifactMaintenance";
import { ARENA_BUILD_GRID_SIZE, ARENA_BUILD_MODE, ARENA_BUILD_PALETTE } from "@/lib/arena/eligibility";
import { prisma } from "@/lib/prisma";
import { copySupabaseStorageObject, isMissingBuildPayloadError } from "@/lib/storage/buildPayload";
import { getBuildStorageBucketFromEnv } from "@/lib/storage/config";

function readPromptId(payload: Prisma.JsonValue | null): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return typeof payload.promptId === "string" ? payload.promptId : null;
}

export async function runGalleryArenaImportJob(
  job: Pick<CustomBuildJob, "customBuildId" | "payload">,
  opts: { beforeArtifactPreparation: () => Promise<unknown> },
): Promise<void> {
  const promptId = readPromptId(job.payload);
  if (!promptId) throw new Error("Arena import job is missing its prompt");
  // unselected or hidden prompts stay out of the arena
  const selected = await prisma.galleryCandidate.findFirst({
    where: { officialPromptId: promptId, selectedAt: { not: null }, removedAt: null, adminHiddenAt: null },
    select: { id: true },
  });
  if (!selected) return;

  const source = await prisma.customBuild.findUnique({
    where: { id: job.customBuildId },
    select: {
      removedAt: true,
      modelKey: true,
      blockCount: true,
      buildSha256: true,
      generationTimeMs: true,
      artifacts: {
        where: { kind: "build_json" },
        select: { bucket: true, path: true, encoding: true, byteSize: true, compressedByteSize: true, sha256: true, storedByteSize: true, format: true, contentType: true, fileName: true },
        take: 1,
      },
    },
  });
  const artifact = source?.artifacts[0];
  const model = source?.modelKey
    ? await prisma.model.findUnique({ where: { key: source.modelKey }, select: { id: true, isBaseline: true } })
    : null;
  if (!source || !model || model.isBaseline) return;

  const buildKey = {
    promptId,
    modelId: model.id,
    gridSize: ARENA_BUILD_GRID_SIZE,
    palette: ARENA_BUILD_PALETTE,
    mode: ARENA_BUILD_MODE,
  };
  const bucket = getBuildStorageBucketFromEnv();
  // source-specific so a reused path always carries the same payload
  const path = `gallery/${promptId}/${source.modelKey}-${job.customBuildId}-g256-simple-precise.json.gz`;
  const existing = await prisma.build.findFirst({ where: buildKey });
  // never replace a build this import did not create, retries resume their own
  if (existing && !existing.active && !existing.arenaImportPending) return;
  let preparedBuildId: string | undefined;
  if (!existing || existing.voxelStoragePath === path) {
    let build = existing;
    if (!build) {
      if (!artifact || source.removedAt) return;
      build = await prisma.$transaction(async (tx) => {
        // serialize build creation with source moderation
        await tx.$queryRaw`SELECT id FROM "CustomBuild" WHERE id = ${job.customBuildId} FOR UPDATE`;
        const current = await tx.build.findFirst({ where: buildKey });
        if (current) return (current.active || current.arenaImportPending) && current.voxelStoragePath === path ? current : null;
        const eligible = await tx.galleryExample.findFirst({
          where: { customBuildId: job.customBuildId, candidateId: selected.id, removedAt: null, adminHiddenAt: null, customBuild: { removedAt: null } },
          select: { id: true },
        });
        if (!eligible) return null;
        return tx.build.create({
          data: {
            ...buildKey,
            active: false,
            arenaImportPending: true,
            voxelData: Prisma.DbNull,
            voxelStorageBucket: bucket,
            voxelStoragePath: path,
            voxelStorageEncoding: artifact.encoding === "gzip" ? "gzip" : null,
            voxelByteSize: Number(artifact.byteSize),
            voxelCompressedByteSize: artifact.compressedByteSize == null ? null : Number(artifact.compressedByteSize),
            voxelSha256: source.buildSha256,
            blockCount: Number(source.blockCount ?? 0),
            generationTimeMs: source.generationTimeMs ?? 0,
          },
        });
      });
      if (!build) return;
    }
    let copyAttempted = false;
    const cleanupId = `arena_cleanup_${build.id}`;
    const destination = { bucket: build.voxelStorageBucket ?? bucket, path };
    try {
      if (build.arenaImportPending && artifact && !source.removedAt) {
        copyAttempted = true;
        await copySupabaseStorageObject({ from: artifact, to: destination });
      }
      await opts.beforeArtifactPreparation();
      await maybePrecomputeArenaArtifactsForBuild(build);
      preparedBuildId = build.id;
    } catch (error) {
      if (!build.arenaImportPending || !source.removedAt || !isMissingBuildPayloadError(error)) throw error;
      await prisma.$transaction(async (tx) => {
        await tx.customBuild.update({ where: { id: job.customBuildId }, data: { deletionPendingAt: new Date() } });
        await tx.build.updateMany({
          where: { id: build.id, voxelStoragePath: path, active: false, arenaImportPending: true },
          data: { arenaImportPending: false },
        });
      });
      return;
    } finally {
      if (!await prisma.build.findFirst({ where: { id: build.id, OR: [{ active: true }, { arenaImportPending: true }] }, select: { id: true } })) {
        try {
          if (copyAttempted && artifact) {
            await prisma.$transaction(async (tx) => {
              await tx.customBuild.update({ where: { id: job.customBuildId }, data: { objectsDeletedAt: null, deletionPendingAt: new Date() } });
              await tx.customBuildArtifact.upsert({
                where: { id: cleanupId },
                create: { ...artifact, ...destination, id: cleanupId, customBuildId: job.customBuildId, kind: "build_json" },
                update: {},
              });
            });
          }
          await deleteCustomBuildArtifact(destination);
          await deleteRetiredGalleryArenaArtifacts(job.customBuildId);
          if (copyAttempted) await prisma.customBuildArtifact.deleteMany({ where: { id: cleanupId } });
        } catch (error) {
          await prisma.customBuild.update({
            where: { id: job.customBuildId },
            data: { deletionPendingAt: new Date(), deletionError: redactSensitiveText(error).slice(0, 500) },
          });
          throw error;
        }
      }
    }
  }
  const published = await prisma.$transaction(async (tx) => {
    // moderation and publication take the candidate lock in the same order
    await tx.$queryRaw`SELECT id FROM "GalleryCandidate" WHERE id = ${selected.id} FOR UPDATE`;
    const eligible = await tx.galleryCandidate.findFirst({
      where: { id: selected.id, officialPromptId: promptId, selectedAt: { not: null }, removedAt: null, adminHiddenAt: null },
      select: { id: true },
    });
    if (!eligible) return;
    if (preparedBuildId) {
      await tx.$queryRaw`SELECT id FROM "CustomBuild" WHERE id = ${job.customBuildId} FOR UPDATE`;
      const published = await tx.build.updateMany({
        where: { id: preparedBuildId, OR: [{ active: true }, { arenaImportPending: true }] },
        data: { active: true, arenaImportPending: false },
      });
      if (published.count === 0) return;
    }
    await tx.prompt.update({ where: { id: promptId }, data: { active: true } });
    return true;
  });
  if (published && preparedBuildId) invalidateArenaBuildMeta(preparedBuildId);
}
