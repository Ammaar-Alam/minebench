import { Prisma, type CustomBuildJob } from "@prisma/client";
import { maybePrecomputeArenaArtifactsForBuild } from "@/lib/arena/artifactMaintenance";
import { ARENA_BUILD_GRID_SIZE, ARENA_BUILD_MODE, ARENA_BUILD_PALETTE } from "@/lib/arena/eligibility";
import { prisma } from "@/lib/prisma";
import { copySupabaseStorageObject } from "@/lib/storage/buildPayload";
import { getBuildStorageBucketFromEnv } from "@/lib/storage/config";

function readPromptId(payload: Prisma.JsonValue | null): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return typeof payload.promptId === "string" ? payload.promptId : null;
}

export async function runGalleryArenaImportJob(
  job: CustomBuildJob,
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
      modelKey: true,
      blockCount: true,
      buildSha256: true,
      generationTimeMs: true,
      artifacts: {
        where: { kind: "build_json" },
        select: { bucket: true, path: true, encoding: true, byteSize: true, compressedByteSize: true },
        take: 1,
      },
    },
  });
  const artifact = source?.artifacts[0];
  const model = source?.modelKey
    ? await prisma.model.findUnique({ where: { key: source.modelKey }, select: { id: true, isBaseline: true } })
    : null;
  if (!source || !artifact || !model || model.isBaseline) return;

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
  if (!existing || existing.voxelStoragePath === path) {
    // an owned copy keeps the arena build alive if the example is later removed
    await copySupabaseStorageObject({ from: artifact, to: { bucket, path } });
    const build = existing ?? await prisma.build.create({
      data: {
        ...buildKey,
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
    await opts.beforeArtifactPreparation();
    await maybePrecomputeArenaArtifactsForBuild(build);
  }
  // one conditional write so a hide or unselect during the import wins
  // a prompt still needs two builds before sampling picks it up
  await prisma.prompt.updateMany({
    where: {
      id: promptId,
      selectedGalleryCandidate: { is: { selectedAt: { not: null }, removedAt: null, adminHiddenAt: null } },
    },
    data: { active: true },
  });
}
