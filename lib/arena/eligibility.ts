import type { Prisma } from "@prisma/client";
import { ARENA_BUILD_SETUPS } from "@/lib/arena/buildSetup";
import { prisma } from "@/lib/prisma";

export const ARENA_BUILD_MODE = "precise";

// a build only competes when it was made with its prompt's setup
export function arenaBuildSetupWhere() {
  return {
    mode: ARENA_BUILD_MODE,
    OR: ARENA_BUILD_SETUPS.map(({ gridSize, palette }) => ({ gridSize, palette, prompt: { gridSize, palette } })),
  } satisfies Prisma.BuildWhereInput;
}

function benchmarkBuildWhere(modelKeys: readonly string[] | undefined, publicOnly: boolean) {
  const scoped = Boolean(modelKeys && modelKeys.length > 0);
  return {
    active: true,
    ...arenaBuildSetupWhere(),
    model: {
      ...(scoped ? { key: { in: [...modelKeys!] } } : { enabled: true }),
      isBaseline: false,
      ...(publicOnly ? { stealthVariant: null } : {}),
    },
    prompt: { active: true },
  };
}

// Public cohort scope used by sampling and publication checks
export function arenaCohortBuildWhere(modelKeys?: readonly string[]) {
  return benchmarkBuildWhere(modelKeys, true);
}

// Delivery artifacts are also required by enabled private checkpoints
export function arenaArtifactBuildWhere(modelKeys?: readonly string[]) {
  return benchmarkBuildWhere(modelKeys, false);
}

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
    WHERE build.active = true
      AND build."gridSize" = prompt."gridSize"
      AND build."palette" = prompt."palette"
      AND build."mode" = ${ARENA_BUILD_MODE}
      AND model.enabled = true
      AND model."isBaseline" = false
      AND NOT EXISTS (
        SELECT 1 FROM "StealthVariant" variant WHERE variant."modelId" = model.id
      )
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
