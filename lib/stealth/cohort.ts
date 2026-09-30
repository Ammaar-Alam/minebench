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
          slug: communityPromptSlug(publicId),
          text: prompt.text,
          gridSize: prompt.gridSize,
          palette: prompt.palette,
          prompt: { id: prompt.id },
        }]
      : [],
  );
  return [...benchmark, ...community];
}

function communityPromptSlug(key: string): string {
  return `community-${key}`;
}

// a slot keeps its prompt even if the community selection changes after creation
export async function loadStealthUploadPrompt(promptId: string): Promise<CohortPrompt | null> {
  const prompt = await prisma.prompt.findUnique({
    where: { id: promptId },
    select: {
      id: true,
      text: true,
      gridSize: true,
      palette: true,
      selectedGalleryCandidate: { select: { publicId: true } },
    },
  });
  if (!prompt) return null;
  const benchmarkSlug = Object.entries(BENCHMARK_PROMPT_MAP).find(([, text]) => text === prompt.text)?.[0];
  if (benchmarkSlug) {
    return {
      slug: benchmarkSlug,
      text: prompt.text,
      gridSize: STEALTH_COHORT_BUILD.gridSize,
      palette: STEALTH_COHORT_BUILD.palette,
      prompt: { id: prompt.id },
    };
  }
  return {
    slug: communityPromptSlug(prompt.selectedGalleryCandidate?.publicId ?? prompt.id),
    text: prompt.text,
    gridSize: prompt.gridSize,
    palette: prompt.palette,
    prompt: { id: prompt.id },
  };
}
