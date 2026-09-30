import type { Prisma } from "@prisma/client";
import { deleteArenaBuildArtifacts } from "@/lib/arena/artifactOwnership";
import { ARENA_BUILD_MODE } from "@/lib/arena/eligibility";
import { BENCHMARK_PROMPT_MAP } from "@/lib/benchmark/prompts";
import { deleteCustomBuildArtifact } from "@/lib/custom-builds/storage";
import { prisma } from "@/lib/prisma";

const BENCHMARK_PROMPTS = new Set(Object.values(BENCHMARK_PROMPT_MAP));

// the fixed benchmark cohort never takes community builds
export function isCommunityArenaPrompt(promptText: string): boolean {
  return !BENCHMARK_PROMPTS.has(promptText);
}

// first published example per model, examples arrive oldest first
export function pickArenaImportSources<T extends { customBuild: { modelKey: string | null } }>(examples: T[]): T[] {
  const seen = new Set<string>();
  return examples.filter(({ customBuild: { modelKey } }) => {
    if (!modelKey || seen.has(modelKey)) return false;
    seen.add(modelKey);
    return true;
  });
}

// moderation and publication take the candidate lock in the same order
export async function lockEligibleGalleryCandidate(
  tx: Prisma.TransactionClient,
  candidateId: string,
  promptId: string,
): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM "GalleryCandidate" WHERE id = ${candidateId} FOR UPDATE`;
  return Boolean(await tx.galleryCandidate.findFirst({
    where: { id: candidateId, officialPromptId: promptId, selectedAt: { not: null }, removedAt: null, adminHiddenAt: null },
    select: { id: true },
  }));
}

export async function deleteRetiredGalleryArenaArtifacts(
  customBuildId: string,
  deleteArtifact: typeof deleteCustomBuildArtifact = deleteCustomBuildArtifact,
): Promise<void> {
  const builds = await prisma.build.findMany({
    where: {
      active: false,
      arenaImportPending: false,
      voxelStoragePath: { startsWith: "gallery/", contains: `-${customBuildId}-g` },
    },
    select: { id: true, promptId: true, voxelSha256: true, voxelStorageBucket: true, voxelStoragePath: true },
  });
  if (!builds.length) return;
  await deleteArenaBuildArtifacts({
    retiringBuilds: builds,
    survivingChecksums: new Set(),
    deleteStorage: async (refs) => { for (const ref of refs) await deleteArtifact(ref); },
  });
  for (const build of builds) {
    if (build.voxelStorageBucket && build.voxelStoragePath) {
      await deleteArtifact({ bucket: build.voxelStorageBucket, path: build.voxelStoragePath });
    }
    await prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Array<{
        id: string; promptText: string; selectedAt: Date | null; adminHiddenAt: Date | null; removedAt: Date | null;
      }>>`
        SELECT id, "promptText", "selectedAt", "adminHiddenAt", "removedAt" FROM "GalleryCandidate"
        WHERE "officialPromptId" = ${build.promptId}
        FOR UPDATE
      `;
      const deleted = await tx.build.deleteMany({ where: {
        id: build.id, active: false, arenaImportPending: false,
        matchupsAsA: { none: {} }, matchupsAsB: { none: {} }, stealthGenerationResults: { none: {} },
      } });
      const candidate = candidates[0];
      if (deleted.count > 0 && candidate?.selectedAt && !candidate.adminHiddenAt && !candidate.removedAt
        && isCommunityArenaPrompt(candidate.promptText)) {
        await queueGalleryArenaImports(tx, candidate.id, build.promptId);
      }
    });
  }
}

export async function queueGalleryArenaImports(
  tx: Prisma.TransactionClient,
  candidateId: string,
  promptId: string,
): Promise<number> {
  const prompt = await tx.prompt.findUnique({ where: { id: promptId }, select: { gridSize: true, palette: true } });
  if (!prompt) return 0;
  const setup = { gridSize: prompt.gridSize, palette: prompt.palette, mode: ARENA_BUILD_MODE };
  const examples = await tx.galleryExample.findMany({
    where: {
      candidateId,
      removedAt: null,
      adminHiddenAt: null,
      customBuild: { status: "succeeded", modelKind: "catalog", removedAt: null, ...setup },
    },
    orderBy: { createdAt: "asc" },
    select: { customBuildId: true, customBuild: { select: { modelKey: true } } },
  });
  // models already in the arena or mid-import keep their build
  const [built, importing] = await Promise.all([
    tx.build.findMany({
      where: { promptId, ...setup },
      select: { model: { select: { key: true } } },
    }),
    tx.customBuildJob.findMany({
      where: { type: "arena_import", status: { in: ["queued", "running"] }, payload: { path: ["promptId"], equals: promptId } },
      select: { customBuild: { select: { modelKey: true } } },
    }),
  ]);
  const covered = new Set([
    ...built.map(({ model }) => model.key),
    ...importing.flatMap(({ customBuild }) => (customBuild.modelKey ? [customBuild.modelKey] : [])),
  ]);
  const sources = pickArenaImportSources(examples).filter(({ customBuild }) => !covered.has(customBuild.modelKey!));
  if (sources.length === 0) return 0;
  await tx.customBuildJob.createMany({
    data: sources.map((source) => ({
      customBuildId: source.customBuildId,
      type: "arena_import" as const,
      // user generations go first
      priority: -1,
      payload: { promptId },
    })),
  });
  return sources.length;
}
