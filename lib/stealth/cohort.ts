import { isArenaBuildSetup } from "@/lib/arena/buildSetup";
import { BENCHMARK_PROMPT_MAP } from "@/lib/benchmark/prompts";
import { isCommunityArenaPrompt } from "@/lib/gallery/arenaImport";
import { prisma } from "@/lib/prisma";

export const STEALTH_COHORT_BUILD = {
  gridSize: 256,
  palette: "simple",
  mode: "precise",
} as const;

export type CohortPrompt = {
  slug: string;
  text: string;
  gridSize: number;
  palette: string;
  prompt: { id: string };
};

export async function prepareStealthCohortPrompts(): Promise<CohortPrompt[]> {
  const prompts = await Promise.all(
    Object.entries(BENCHMARK_PROMPT_MAP).map(async ([slug, text]) => ({
      slug,
      text,
      gridSize: STEALTH_COHORT_BUILD.gridSize,
      palette: STEALTH_COHORT_BUILD.palette,
      prompt: await prisma.prompt.upsert({
        where: { text },
        create: { text, active: true },
        update: {},
        select: { id: true },
      }),
    })),
  );
  return prompts.sort((a, b) => {
    if (a.slug === "astronaut") return -1;
    if (b.slug === "astronaut") return 1;
    return a.slug.localeCompare(b.slug);
  });
}

// uploads may also cover selected community prompts, each with its own setup
export async function prepareStealthUploadPrompts(): Promise<CohortPrompt[]> {
  const [benchmark, candidates] = await Promise.all([
    prepareStealthCohortPrompts(),
    prisma.galleryCandidate.findMany({
      where: {
        selectedAt: { not: null },
        removedAt: null,
        adminHiddenAt: null,
        officialPrompt: { active: true },
      },
      orderBy: { selectedAt: "asc" },
      select: {
        publicId: true,
        officialPrompt: { select: { id: true, text: true, gridSize: true, palette: true } },
      },
    }),
  ]);
  const community = candidates.flatMap(({ publicId, officialPrompt: prompt }) =>
    prompt && isCommunityArenaPrompt(prompt.text) && isArenaBuildSetup(prompt)
      ? [{
          slug: `community-${publicId}`,
          text: prompt.text,
          gridSize: prompt.gridSize,
          palette: prompt.palette,
          prompt: { id: prompt.id },
        }]
      : [],
  );
  return [...benchmark, ...community];
}
