import { BENCHMARK_PROMPT_MAP } from "@/lib/benchmark/prompts";
import { prisma } from "@/lib/prisma";

export const STEALTH_COHORT_BUILD = {
  gridSize: 256,
  palette: "simple",
  mode: "precise",
} as const;

export type CohortPrompt = {
  slug: string;
  text: string;
  prompt: { id: string };
};

export async function prepareStealthCohortPrompts(): Promise<CohortPrompt[]> {
  const prompts = await Promise.all(
    Object.entries(BENCHMARK_PROMPT_MAP).map(async ([slug, text]) => ({
      slug,
      text,
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
