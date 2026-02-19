import { prisma } from "@/lib/prisma";

export const ARENA_BUILD_GRID_SIZE = 256;
export const ARENA_BUILD_PALETTE = "simple";
export const ARENA_BUILD_MODE = "precise";

type EligiblePromptRow = {
  promptId: string;
};

export async function getArenaEligiblePromptIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<EligiblePromptRow[]>`
    SELECT
      build."promptId" AS "promptId"
    FROM "Build" build
    INNER JOIN "Model" model ON model.id = build."modelId"
    INNER JOIN "Prompt" prompt ON prompt.id = build."promptId"
    WHERE build."gridSize" = ${ARENA_BUILD_GRID_SIZE}
      AND build."palette" = ${ARENA_BUILD_PALETTE}
      AND build."mode" = ${ARENA_BUILD_MODE}
      AND model.enabled = true
      AND model."isBaseline" = false
      AND prompt.active = true
    GROUP BY build."promptId"
    HAVING COUNT(*) >= 2
  `;

  return rows.map((row) => row.promptId);
}

export async function listArenaEligiblePrompts(): Promise<Array<{ id: string; text: string }>> {
  const promptIds = await getArenaEligiblePromptIds();
  if (promptIds.length === 0) return [];

  return prisma.prompt.findMany({
    where: {
      id: { in: promptIds },
      active: true,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, text: true },
  });
}
