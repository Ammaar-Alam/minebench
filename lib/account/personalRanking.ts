import { Prisma } from "@prisma/client";
import { resolveModelSlug } from "@/lib/ai/modelCatalog";
import {
  aggregatePairRow,
  fitBradleyTerry,
  getGlobalBradleyTerrySnapshot,
  type GlobalModelBradleyTerryStats,
  type PairwiseRow,
} from "@/lib/arena/stats";
import { prisma } from "@/lib/prisma";

type NumberLike = number | bigint | string | null;

export type PersonalPairAggregate = {
  modelAId: string;
  modelBId: string;
  pointsA: number;
  pointsB: number;
  total: number;
};

export type PersonalOutcomeAggregate = {
  modelId: string;
  wins: number;
  losses: number;
  ties: number;
  bothBad: number;
  votes: number;
};

export type PersonalModelRanking = PersonalOutcomeAggregate & {
  rank: number;
  key: string;
  slug: string;
  provider: string;
  displayName: string;
};

export type PersonalRanking = {
  totalVotes: number;
  ratedVotes: number;
  modelsCompared: number;
  models: PersonalModelRanking[];
};

function toNumber(value: NumberLike): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

export function rankPersonalModels(input: {
  pairs: PersonalPairAggregate[];
  outcomes: PersonalOutcomeAggregate[];
  globalModels: GlobalModelBradleyTerryStats[];
  alphaByModelId: Map<string, number>;
}): PersonalModelRanking[] {
  const pairRows = new Map<string, PairwiseRow>();
  const modelIds = new Set<string>();
  for (const row of input.pairs) {
    aggregatePairRow(
      pairRows,
      row.modelAId,
      row.modelBId,
      row.pointsA,
      row.pointsB,
      row.total,
    );
    modelIds.add(row.modelAId);
    modelIds.add(row.modelBId);
  }
  if (modelIds.size < 2) return [];

  const modelById = new Map(input.globalModels.map((model) => [model.id, model]));
  const displayNames = new Map(
    [...modelIds].map((id) => [id, modelById.get(id)?.displayName ?? id]),
  );
  const outcomesByModelId = new Map(input.outcomes.map((row) => [row.modelId, row]));
  const fit = fitBradleyTerry(
    modelIds,
    [...pairRows.values()],
    displayNames,
    input.alphaByModelId,
  );

  return fit.flatMap((row, index) => {
    const model = modelById.get(row.id);
    const outcome = outcomesByModelId.get(row.id);
    if (!model || !outcome) return [];
    return [{
      ...outcome,
      rank: index + 1,
      key: model.key,
      slug: resolveModelSlug(model.key),
      provider: model.provider,
      displayName: model.displayName,
    }];
  });
}

export async function getPersonalRanking(userId: string): Promise<PersonalRanking> {
  const [global, totalVotes] = await Promise.all([
    getGlobalBradleyTerrySnapshot(),
    prisma.vote.count({
      where: { userId, matchup: { stealthVariantId: null } },
    }),
  ]);
  const { eligiblePromptIds, activeModelIds } = global;
  if (eligiblePromptIds.length === 0 || activeModelIds.length < 2) {
    return { totalVotes, ratedVotes: 0, modelsCompared: 0, models: [] };
  }

  const [pairRows, outcomeRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        modelAId: string;
        modelBId: string;
        pointsA: NumberLike;
        pointsB: NumberLike;
        total: NumberLike;
      }>
    >(Prisma.sql`
      SELECT
        matchup."modelAId" AS "modelAId",
        matchup."modelBId" AS "modelBId",
        SUM(CASE vote.choice WHEN 'A' THEN 1.0 WHEN 'TIE' THEN 0.5 ELSE 0.0 END)::double precision AS "pointsA",
        SUM(CASE vote.choice WHEN 'B' THEN 1.0 WHEN 'TIE' THEN 0.5 ELSE 0.0 END)::double precision AS "pointsB",
        COUNT(*)::int AS total
      FROM "Vote" vote
      INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
      WHERE vote."userId" = CAST(${userId} AS UUID)
        AND vote.choice IN ('A', 'B', 'TIE')
        AND matchup."stealthVariantId" IS NULL
        AND matchup."promptId" IN (${Prisma.join(eligiblePromptIds)})
        AND matchup."modelAId" IN (${Prisma.join(activeModelIds)})
        AND matchup."modelBId" IN (${Prisma.join(activeModelIds)})
      GROUP BY matchup."modelAId", matchup."modelBId"
    `),
    prisma.$queryRaw<
      Array<{
        modelId: string;
        wins: NumberLike;
        losses: NumberLike;
        ties: NumberLike;
        bothBad: NumberLike;
        votes: NumberLike;
      }>
    >(Prisma.sql`
      WITH user_votes AS (
        SELECT matchup."modelAId", matchup."modelBId", vote.choice
        FROM "Vote" vote
        INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
        WHERE vote."userId" = CAST(${userId} AS UUID)
          AND vote.choice IN ('A', 'B', 'TIE', 'BOTH_BAD')
          AND matchup."stealthVariantId" IS NULL
          AND matchup."promptId" IN (${Prisma.join(eligiblePromptIds)})
          AND matchup."modelAId" IN (${Prisma.join(activeModelIds)})
          AND matchup."modelBId" IN (${Prisma.join(activeModelIds)})
      ), model_outcomes AS (
        SELECT
          "modelAId" AS "modelId",
          CASE choice WHEN 'A' THEN 'win' WHEN 'B' THEN 'loss' WHEN 'TIE' THEN 'tie' ELSE 'both_bad' END AS outcome
        FROM user_votes
        UNION ALL
        SELECT
          "modelBId" AS "modelId",
          CASE choice WHEN 'B' THEN 'win' WHEN 'A' THEN 'loss' WHEN 'TIE' THEN 'tie' ELSE 'both_bad' END AS outcome
        FROM user_votes
      )
      SELECT
        "modelId",
        COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
        COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses,
        COUNT(*) FILTER (WHERE outcome = 'tie')::int AS ties,
        COUNT(*) FILTER (WHERE outcome = 'both_bad')::int AS "bothBad",
        COUNT(*)::int AS votes
      FROM model_outcomes
      GROUP BY "modelId"
    `),
  ]);

  const pairs = pairRows.map((row) => ({
    modelAId: row.modelAId,
    modelBId: row.modelBId,
    pointsA: toNumber(row.pointsA),
    pointsB: toNumber(row.pointsB),
    total: toNumber(row.total),
  }));
  const outcomes = outcomeRows.map((row) => ({
    modelId: row.modelId,
    wins: toNumber(row.wins),
    losses: toNumber(row.losses),
    ties: toNumber(row.ties),
    bothBad: toNumber(row.bothBad),
    votes: toNumber(row.votes),
  }));
  const models = rankPersonalModels({
    pairs,
    outcomes,
    globalModels: global.globalModels,
    alphaByModelId: global.alphaByModelId,
  });

  return {
    totalVotes,
    ratedVotes: pairs.reduce((sum, row) => sum + row.total, 0),
    modelsCompared: models.length,
    models,
  };
}
