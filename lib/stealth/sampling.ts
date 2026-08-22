import { Prisma } from "@prisma/client";
import type {
  ArenaMatchupSamplingState,
  EligibleBuildMeta,
  EligibleModel,
  EligiblePrompt,
} from "@/lib/arena/coverage";
import { weightedPick } from "@/lib/arena/sampling";
import { prisma } from "@/lib/prisma";
import {
  ACTIVE_STEALTH_EXPERIMENT_STATUSES,
  hasReachedStealthVoteGoal,
  isStealthVoteGoalEnforced,
} from "@/lib/stealth/policy";

const CACHE_TTL_MS = 15_000;
const ARENA_GRID_SIZE = 256;
const ARENA_PALETTE = "simple";
const ARENA_MODE = "precise";

type VariantSnapshot = {
  id: string;
  targetDecisiveVotes: number | null;
  pauseAtGoal: boolean;
  model: EligibleModel;
  buildsByPromptId: Map<string, EligibleBuildMeta>;
  promptVotes: Map<string, number>;
  opponentVotes: Map<string, number>;
  decisiveVotes: number;
};

type StealthSamplingSnapshot = {
  variants: VariantSnapshot[];
};

export type StealthMatchupSelection = {
  prompt: EligiblePrompt;
  stealthVariantId: string;
  stealthModel: EligibleModel;
  stealthBuild: EligibleBuildMeta;
  publicModel: EligibleModel;
};

type OpponentCountRow = {
  stealthVariantId: string;
  publicModelId: string;
  votes: number | bigint | string;
};

let cachedSnapshot: { expiresAt: number; value: StealthSamplingSnapshot } | null = null;
let snapshotInFlight: Promise<StealthSamplingSnapshot> | null = null;

function toNumber(value: number | bigint | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function querySnapshot(): Promise<StealthSamplingSnapshot> {
  const variants = await prisma.stealthVariant.findMany({
    where: {
      status: "ACTIVE",
      experiment: { status: { in: [...ACTIVE_STEALTH_EXPERIMENT_STATUSES] } },
      model: { enabled: true },
    },
    select: {
      id: true,
      codename: true,
      eloRating: true,
      conservativeRating: true,
      glickoRd: true,
      shownCount: true,
      winCount: true,
      lossCount: true,
      _count: {
        select: {
          voteJobs: { where: { processedAt: null, choice: { in: ["A", "B"] } } },
        },
      },
      experiment: { select: { targetDecisiveVotes: true, pauseAtGoal: true } },
      model: {
        select: {
          id: true,
          key: true,
          builds: {
            where: {
              gridSize: ARENA_GRID_SIZE,
              palette: ARENA_PALETTE,
              mode: ARENA_MODE,
              prompt: { active: true },
            },
            select: {
              id: true,
              promptId: true,
              gridSize: true,
              palette: true,
              blockCount: true,
              voxelByteSize: true,
              voxelCompressedByteSize: true,
              voxelSha256: true,
              arenaBuildHints: true,
            },
          },
        },
      },
    },
  });

  if (variants.length === 0) return { variants: [] };
  const variantIds = variants.map((variant) => variant.id);
  const [promptCounts, opponentCounts] = await Promise.all([
    prisma.matchup.groupBy({
      by: ["stealthVariantId", "promptId"],
      where: { stealthVariantId: { in: variantIds } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<OpponentCountRow[]>(Prisma.sql`
      SELECT
        matchup."stealthVariantId" AS "stealthVariantId",
        CASE
          WHEN matchup."modelAId" = variant."modelId" THEN matchup."modelBId"
          ELSE matchup."modelAId"
        END AS "publicModelId",
        COUNT(*)::int AS votes
      FROM "Matchup" matchup
      INNER JOIN "StealthVariant" variant ON variant.id = matchup."stealthVariantId"
      WHERE matchup."stealthVariantId" IN (${Prisma.join(variantIds)})
      GROUP BY matchup."stealthVariantId", "publicModelId"
    `),
  ]);

  const promptVotesByVariant = new Map<string, Map<string, number>>();
  for (const row of promptCounts) {
    if (!row.stealthVariantId) continue;
    const counts = promptVotesByVariant.get(row.stealthVariantId) ?? new Map<string, number>();
    counts.set(row.promptId, row._count._all);
    promptVotesByVariant.set(row.stealthVariantId, counts);
  }
  const opponentVotesByVariant = new Map<string, Map<string, number>>();
  for (const row of opponentCounts) {
    const counts = opponentVotesByVariant.get(row.stealthVariantId) ?? new Map<string, number>();
    counts.set(row.publicModelId, toNumber(row.votes));
    opponentVotesByVariant.set(row.stealthVariantId, counts);
  }

  return {
    variants: variants.map((variant) => ({
      id: variant.id,
      targetDecisiveVotes: variant.experiment.targetDecisiveVotes,
      pauseAtGoal: variant.experiment.pauseAtGoal,
      model: {
        id: variant.model.id,
        key: variant.model.key,
        provider: "Stealth",
        displayName: variant.codename,
        eloRating: Number(variant.eloRating),
        conservativeRating: Number(variant.conservativeRating),
        ratingDeviation: Number(variant.glickoRd),
        shownCount: variant.shownCount,
      },
      buildsByPromptId: new Map(
        variant.model.builds.map(({ promptId, ...build }) => [promptId, build]),
      ),
      promptVotes: promptVotesByVariant.get(variant.id) ?? new Map(),
      opponentVotes: opponentVotesByVariant.get(variant.id) ?? new Map(),
      decisiveVotes: variant.winCount + variant.lossCount + variant._count.voteJobs,
    })),
  };
}

async function getSnapshot(): Promise<StealthSamplingSnapshot> {
  if (cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) return cachedSnapshot.value;
  snapshotInFlight ??= querySnapshot()
    .then((value) => {
      cachedSnapshot = { expiresAt: Date.now() + CACHE_TTL_MS, value };
      return value;
    })
    .finally(() => {
      snapshotInFlight = null;
    });
  return snapshotInFlight;
}

export function invalidateStealthSamplingCache(): void {
  cachedSnapshot = null;
  snapshotInFlight = null;
}

export async function pickStealthMatchup(params: {
  publicState: ArenaMatchupSamplingState;
  forcedPromptId?: string;
}): Promise<StealthMatchupSelection | null> {
  const snapshot = await getSnapshot();
  const promptById = new Map(params.publicState.prompts.map((prompt) => [prompt.id, prompt]));
  const candidates = snapshot.variants.filter((variant) => {
    if (hasReachedStealthVoteGoal(variant, variant.decisiveVotes)) {
      return false;
    }
    if (params.forcedPromptId) return variant.buildsByPromptId.has(params.forcedPromptId);
    return Array.from(variant.buildsByPromptId.keys()).some((promptId) => promptById.has(promptId));
  });
  const variant = weightedPick(candidates, (candidate) => {
    const remaining = isStealthVoteGoalEnforced(candidate)
      ? Math.max(1, (candidate.targetDecisiveVotes ?? 0) - candidate.decisiveVotes)
      : 1;
    return remaining / Math.max(1, candidate.model.shownCount + 1);
  });
  if (!variant) return null;

  const prompts = Array.from(variant.buildsByPromptId.keys())
    .filter((promptId) => !params.forcedPromptId || promptId === params.forcedPromptId)
    .map((promptId) => promptById.get(promptId) ?? null)
    .filter((prompt): prompt is EligiblePrompt => prompt != null && prompt.modelIds.length > 0);
  const prompt = weightedPick(prompts, (candidate) => 1 / ((variant.promptVotes.get(candidate.id) ?? 0) + 1));
  if (!prompt) return null;

  const publicModels = prompt.modelIds
    .map((modelId) => params.publicState.modelsById.get(modelId) ?? null)
    .filter((model): model is EligibleModel => model != null);
  const publicModel = weightedPick(publicModels, (candidate) => {
    const pairVotes = variant.opponentVotes.get(candidate.id) ?? 0;
    const ratingDistance = Math.abs(candidate.eloRating - variant.model.eloRating);
    return (1 / (pairVotes + 1)) * (1 / (1 + ratingDistance / 400));
  });
  const stealthBuild = variant.buildsByPromptId.get(prompt.id) ?? null;
  if (!publicModel || !stealthBuild) return null;

  const stillActive = await prisma.stealthVariant.count({
    where: {
      id: variant.id,
      status: "ACTIVE",
      experiment: { status: { in: [...ACTIVE_STEALTH_EXPERIMENT_STATUSES] } },
      model: { enabled: true },
    },
  });
  if (stillActive === 0) {
    invalidateStealthSamplingCache();
    return null;
  }

  return {
    prompt,
    stealthVariantId: variant.id,
    stealthModel: variant.model,
    stealthBuild,
    publicModel,
  };
}
