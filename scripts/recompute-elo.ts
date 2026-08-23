#!/usr/bin/env -S tsx
/**
 * Recompute Arena Bradley-Terry rating + vote counters from stored vote history.
 *
 * Usage:
 *   pnpm elo:recompute         # dry run
 *   pnpm elo:recompute --yes   # apply recomputed values
 */

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  BT_EDGE_PRIOR_POINTS,
  BT_EDGE_PRIOR_TOTAL,
  INITIAL_RATING,
  computeConfidenceAwareRanks,
  confidenceFromCi,
  confidenceInterval95,
  stabilityTier,
  thetaToRating,
  varianceToStandardError,
} from "../lib/arena/rating";
import {
  type PairwiseRow,
  fitBradleyTerry,
} from "../lib/arena/stats";

type Choice = "A" | "B" | "TIE" | "BOTH_BAD";

function parseArgs(argv: string[]) {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    yes: argv.includes("--yes") || argv.includes("--apply"),
  };
}

function isChoice(value: string): value is Choice {
  return value === "A" || value === "B" || value === "TIE" || value === "BOTH_BAD";
}

function formatDelta(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function pairKey(modelAId: string, modelBId: string): string {
  return modelAId < modelBId ? `${modelAId}|${modelBId}` : `${modelBId}|${modelAId}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Recompute MineBench Arena Bradley-Terry ratings + counters from vote history.

Usage:
  pnpm elo:recompute
  pnpm elo:recompute --yes
`.trim());
    return;
  }

  const [models, votes] = await Promise.all([
    prisma.model.findMany({
      select: {
        id: true,
        key: true,
        displayName: true,
        provider: true,
        enabled: true,
        isBaseline: true,
        eloRating: true,
        glickoRd: true,
        glickoVolatility: true,
        conservativeRating: true,
        winCount: true,
        lossCount: true,
        drawCount: true,
        bothBadCount: true,
      },
    }),
    prisma.vote.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        choice: true,
        matchup: {
          select: {
            promptId: true,
            modelAId: true,
            modelBId: true,
          },
        },
      },
    }),
  ]);

  const modelMap = new Map(models.map((m) => [m.id, m]));
  const activeModels = models.filter((m) => m.enabled && !m.isBaseline);
  const activeModelIdSet = new Set(activeModels.map((m) => m.id));
  const displayNames = new Map(models.map((m) => [m.id, m.displayName]));

  const countersByModelId = new Map<
    string,
    { winCount: number; lossCount: number; drawCount: number; bothBadCount: number }
  >();

  for (const model of models) {
    countersByModelId.set(model.id, {
      winCount: 0,
      lossCount: 0,
      drawCount: 0,
      bothBadCount: 0,
    });
  }

  const pairRowsMap = new Map<string, PairwiseRow>();

  for (const vote of votes) {
    if (!isChoice(vote.choice)) continue;
    const modelAId = vote.matchup.modelAId;
    const modelBId = vote.matchup.modelBId;
    const countersA = countersByModelId.get(modelAId);
    const countersB = countersByModelId.get(modelBId);

    if (vote.choice === "BOTH_BAD") {
      if (countersA) countersA.bothBadCount += 1;
      if (countersB) countersB.bothBadCount += 1;
      continue;
    }

    if (vote.choice === "A") {
      if (countersA) countersA.winCount += 1;
      if (countersB) countersB.lossCount += 1;
    } else if (vote.choice === "B") {
      if (countersA) countersA.lossCount += 1;
      if (countersB) countersB.winCount += 1;
    } else {
      if (countersA) countersA.drawCount += 1;
      if (countersB) countersB.drawCount += 1;
    }

    // Only active, non-baseline pairwise matchups contribute to global Bradley-Terry fit
    if (!activeModelIdSet.has(modelAId) || !activeModelIdSet.has(modelBId) || modelAId === modelBId) {
      continue;
    }

    const canonicalA = modelAId < modelBId ? modelAId : modelBId;
    const canonicalB = canonicalA === modelAId ? modelBId : modelAId;
    const pointsA = vote.choice === "A" ? 1 : vote.choice === "B" ? 0 : 0.5;
    const pointsB = 1 - pointsA;
    const canonicalPointsA = canonicalA === modelAId ? pointsA : pointsB;
    const canonicalPointsB = canonicalA === modelAId ? pointsB : pointsA;

    const key = pairKey(canonicalA, canonicalB);
    const existing = pairRowsMap.get(key) ?? {
      modelAId: canonicalA,
      modelBId: canonicalB,
      pointsA: 0,
      pointsB: 0,
      total: 0,
    };
    existing.pointsA += canonicalPointsA;
    existing.pointsB += canonicalPointsB;
    existing.total += 1;
    pairRowsMap.set(key, existing);
  }

  const activeModelIds = activeModels.map((m) => m.id);
  const btFitRows = fitBradleyTerry(activeModelIds, [...pairRowsMap.values()], displayNames);
  const btRowByModelId = new Map(btFitRows.map((r) => [r.id, r]));

  const rawRanked = activeModels.map((m) => {
    const bt = btRowByModelId.get(m.id);
    const theta = bt?.theta ?? 0;
    const variance = bt?.variance ?? 1;
    const rating = thetaToRating(theta);
    const standardError = varianceToStandardError(variance);
    const ci95 = confidenceInterval95(standardError);
    const confidence = confidenceFromCi(ci95);
    const counters = countersByModelId.get(m.id) ?? {
      winCount: 0,
      lossCount: 0,
      drawCount: 0,
      bothBadCount: 0,
    };
    const decisiveVotes = counters.winCount + counters.lossCount + counters.drawCount;
    const totalVotes = decisiveVotes + counters.bothBadCount;
    const stability = stabilityTier({
      decisiveVotes,
      promptCoverage: 1.0,
      ci95,
    });

    return {
      id: m.id,
      key: m.key,
      displayName: m.displayName,
      oldRating: Number(m.eloRating),
      oldConservative: Number(m.conservativeRating),
      oldRd: Number(m.glickoRd),
      rating,
      standardError,
      ci95,
      ciLower: Math.round(rating - ci95),
      ciUpper: Math.round(rating + ci95),
      confidence,
      stability,
      counters,
      decisiveVotes,
      totalVotes,
    };
  });

  const rankedModels = computeConfidenceAwareRanks(rawRanked);

  console.log(`========================================================================================`);
  console.log(`MineBench Global Bradley-Terry Leaderboard (Recomputed from ${votes.length} votes)`);
  console.log(`========================================================================================`);
  console.log(
    `Rank | Model                               | Rating | 95% CI   | Interval     | Record (W-L-D)   | Conf | Old Glicko | Delta`,
  );
  console.log(
    `-----+-------------------------------------+--------+----------+--------------+------------------+------+------------+-------`,
  );

  for (const m of rankedModels) {
    const rankStr = `#${m.rank}`.padEnd(4);
    const nameStr = m.displayName.slice(0, 35).padEnd(35);
    const ratingStr = Math.round(m.rating).toString().padStart(6);
    const ciStr = `±${m.ci95.toFixed(1)}`.padStart(8);
    const intervalStr = `[${m.ciLower}, ${m.ciUpper}]`.padStart(12);
    const recordStr = `${m.counters.winCount}-${m.counters.lossCount}-${m.counters.drawCount}`.padStart(16);
    const confStr = `${m.confidence}%`.padStart(4);
    const oldScoreStr = Math.round(m.oldConservative).toString().padStart(10);
    const deltaStr = formatDelta(m.rating - m.oldConservative).padStart(6);

    console.log(
      `${rankStr} | ${nameStr} | ${ratingStr} | ${ciStr} | ${intervalStr} | ${recordStr} | ${confStr} | ${oldScoreStr} | ${deltaStr}`,
    );
  }
  console.log(`========================================================================================`);

  if (!args.yes) {
    console.log("\nDry run completed. Pass --yes to apply recomputed Bradley-Terry ratings to the database.");
    return;
  }

  const updates = [
    ...rankedModels.map((m) =>
      prisma.model.update({
        where: { id: m.id },
        data: {
          eloRating: Math.round(m.rating),
          conservativeRating: Math.round(m.rating),
          glickoRd: Math.round(m.standardError),
          glickoVolatility: 0.0,
          winCount: m.counters.winCount,
          lossCount: m.counters.lossCount,
          drawCount: m.counters.drawCount,
          bothBadCount: m.counters.bothBadCount,
        },
      }),
    ),
    ...models
      .filter((m) => !activeModelIdSet.has(m.id))
      .map((m) => {
        const counters = countersByModelId.get(m.id);
        return prisma.model.update({
          where: { id: m.id },
          data: {
            winCount: counters?.winCount ?? 0,
            lossCount: counters?.lossCount ?? 0,
            drawCount: counters?.drawCount ?? 0,
            bothBadCount: counters?.bothBadCount ?? 0,
          },
        });
      }),
  ];

  for (const update of updates) {
    await update;
  }

  console.log(`\nSuccessfully applied Bradley-Terry ratings and counters to ${models.length} models.`);
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
