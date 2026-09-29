import type { Prisma } from "@prisma/client";
import { ARENA_BUILD_GRID_SIZE, ARENA_BUILD_MODE, ARENA_BUILD_PALETTE } from "@/lib/arena/eligibility";
import { BENCHMARK_PROMPT_MAP } from "@/lib/benchmark/prompts";

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

export async function queueGalleryArenaImports(
  tx: Prisma.TransactionClient,
  candidateId: string,
  promptId: string,
): Promise<number> {
  const examples = await tx.galleryExample.findMany({
    where: {
      candidateId,
      removedAt: null,
      adminHiddenAt: null,
      customBuild: {
        status: "succeeded",
        modelKind: "catalog",
        removedAt: null,
        gridSize: ARENA_BUILD_GRID_SIZE,
        palette: ARENA_BUILD_PALETTE,
        mode: ARENA_BUILD_MODE,
      },
    },
    orderBy: { createdAt: "asc" },
    select: { customBuildId: true, customBuild: { select: { modelKey: true } } },
  });
  const sources = pickArenaImportSources(examples);
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
