#!/usr/bin/env -S tsx
/**
 * Recompute public Bradley-Terry ratings and all Arena vote counters from history.
 *
 * Usage:
 *   pnpm elo:recompute         # dry run
 *   pnpm elo:recompute --yes   # apply recomputed values
 */

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  INITIAL_RATING,
  INITIAL_RD,
  INITIAL_VOLATILITY,
  computeOrdinalRanks,
  confidenceFromCi,
  confidenceInterval95,
  conservativeScore,
  thetaToRating,
  updateRatingPair,
  varianceToStandardError,
} from "../lib/arena/rating";
import { aggregatePairRow, type PairwiseRow, fitBradleyTerry } from "../lib/arena/stats";
import { getArenaEligiblePromptIds } from "../lib/arena/eligibility";
import { applyStealthRatingVote } from "../lib/stealth/rating";

type Choice = "A" | "B" | "TIE" | "BOTH_BAD";

type ModelState = {
  rating: number;
  rd: number;
  volatility: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
  bothBadCount: number;
};

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

function initialState(): ModelState {
  return {
    rating: INITIAL_RATING,
    rd: INITIAL_RD,
    volatility: INITIAL_VOLATILITY,
    winCount: 0,
    lossCount: 0,
    drawCount: 0,
    bothBadCount: 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Recompute MineBench public Bradley-Terry ratings and Arena counters from vote history.

Usage:
  pnpm elo:recompute
  pnpm elo:recompute --yes
`.trim());
    return;
  }

  const [models, variants, votes, eligiblePromptIds] = await Promise.all([
    prisma.model.findMany({
      where: { stealthVariant: null },
      select: {
        id: true,
        key: true,
        displayName: true,
        enabled: true,
        isBaseline: true,
        eloRating: true,
        glickoRd: true,
        conservativeRating: true,
        winCount: true,
        lossCount: true,
        drawCount: true,
        bothBadCount: true,
      },
    }),
    prisma.stealthVariant.findMany({
      select: {
        id: true,
        codename: true,
        modelId: true,
        conservativeRating: true,
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
            stealthVariantId: true,
          },
        },
      },
    }),
    getArenaEligiblePromptIds(),
  ]);

  const activeModels = models.filter((model) => model.enabled && !model.isBaseline);
  const activeModelIdSet = new Set(activeModels.map((model) => model.id));
  const eligiblePromptIdSet = new Set(eligiblePromptIds);
  const displayNames = new Map(models.map((model) => [model.id, model.displayName]));
  const stateByModelId = new Map(models.map((model) => [model.id, initialState()]));
  const stateByVariantId = new Map(variants.map((variant) => [variant.id, initialState()]));
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const pairRows = new Map<string, PairwiseRow>();
  let publicVotesReplayed = 0;
  let privateVotesReplayed = 0;
  let fittedPublicVotes = 0;

  for (const vote of votes) {
    if (!isChoice(vote.choice)) continue;

    if (vote.matchup.stealthVariantId) {
      const variantRecord = variantById.get(vote.matchup.stealthVariantId);
      const variant = stateByVariantId.get(vote.matchup.stealthVariantId);
      if (!variantRecord || !variant) continue;

      const variantIsA = vote.matchup.modelAId === variantRecord.modelId;
      const variantIsB = vote.matchup.modelBId === variantRecord.modelId;
      if (variantIsA === variantIsB) continue;

      const publicAnchor = stateByModelId.get(
        variantIsA ? vote.matchup.modelBId : vote.matchup.modelAId,
      );
      if (!publicAnchor) continue;

      const updated = applyStealthRatingVote({
        variant: {
          eloRating: variant.rating,
          glickoRd: variant.rd,
          glickoVolatility: variant.volatility,
          conservativeRating: conservativeScore(variant.rating, variant.rd),
          winCount: variant.winCount,
          lossCount: variant.lossCount,
          drawCount: variant.drawCount,
          bothBadCount: variant.bothBadCount,
        },
        publicAnchor: {
          eloRating: publicAnchor.rating,
          glickoRd: publicAnchor.rd,
          glickoVolatility: publicAnchor.volatility,
        },
        variantSide: variantIsA ? "A" : "B",
        choice: vote.choice,
      });

      variant.rating = updated.eloRating;
      variant.rd = updated.glickoRd;
      variant.volatility = updated.glickoVolatility;
      variant.winCount = updated.winCount;
      variant.lossCount = updated.lossCount;
      variant.drawCount = updated.drawCount;
      variant.bothBadCount = updated.bothBadCount;
      privateVotesReplayed += 1;
      continue;
    }

    const modelAId = vote.matchup.modelAId;
    const modelBId = vote.matchup.modelBId;
    const modelA = stateByModelId.get(modelAId);
    const modelB = stateByModelId.get(modelBId);
    if (!modelA || !modelB) continue;
    publicVotesReplayed += 1;

    if (vote.choice === "BOTH_BAD") {
      modelA.bothBadCount += 1;
      modelB.bothBadCount += 1;
      continue;
    }

    const outcome = vote.choice === "A" ? "A_WIN" : vote.choice === "B" ? "B_WIN" : "DRAW";
    const updated = updateRatingPair({
      a: { rating: modelA.rating, rd: modelA.rd, volatility: modelA.volatility },
      b: { rating: modelB.rating, rd: modelB.rd, volatility: modelB.volatility },
      outcome,
    });

    modelA.rating = updated.a.rating;
    modelA.rd = updated.a.rd;
    modelA.volatility = updated.a.volatility;
    modelB.rating = updated.b.rating;
    modelB.rd = updated.b.rd;
    modelB.volatility = updated.b.volatility;

    if (vote.choice === "A") {
      modelA.winCount += 1;
      modelB.lossCount += 1;
    } else if (vote.choice === "B") {
      modelA.lossCount += 1;
      modelB.winCount += 1;
    } else {
      modelA.drawCount += 1;
      modelB.drawCount += 1;
    }

    if (
      !eligiblePromptIdSet.has(vote.matchup.promptId) ||
      !activeModelIdSet.has(modelAId) ||
      !activeModelIdSet.has(modelBId) ||
      modelAId === modelBId
    ) {
      continue;
    }

    const pointsA = vote.choice === "A" ? 1 : vote.choice === "B" ? 0 : 0.5;
    aggregatePairRow(pairRows, modelAId, modelBId, pointsA, 1 - pointsA);
    fittedPublicVotes += 1;
  }

  const fittedRows = fitBradleyTerry(
    activeModelIdSet,
    [...pairRows.values()],
    displayNames,
  );
  const fittedByModelId = new Map(fittedRows.map((row) => [row.id, row]));
  const rankedModels = computeOrdinalRanks(
    activeModels.map((model) => {
      const fitted = fittedByModelId.get(model.id);
      const rating = thetaToRating(fitted?.theta ?? 0);
      const standardError = varianceToStandardError(fitted?.variance ?? 1);
      const ci95 = confidenceInterval95(standardError);
      const counters = stateByModelId.get(model.id) as ModelState;

      return {
        id: model.id,
        displayName: model.displayName,
        oldConservative: Number(model.conservativeRating),
        rating,
        standardError,
        ci95,
        ciLower: Math.round(rating - ci95),
        ciUpper: Math.round(rating + ci95),
        confidence: confidenceFromCi(ci95),
        counters,
      };
    }),
  );

  const variantDiffs = variants.map((variant) => {
    const recomputed = stateByVariantId.get(variant.id) as ModelState;
    return {
      id: variant.id,
      codename: variant.codename,
      oldConservative: Number(variant.conservativeRating),
      newRating: recomputed.rating,
      newRd: recomputed.rd,
      newVolatility: recomputed.volatility,
      newConservative: conservativeScore(recomputed.rating, recomputed.rd),
      winCount: recomputed.winCount,
      lossCount: recomputed.lossCount,
      drawCount: recomputed.drawCount,
      bothBadCount: recomputed.bothBadCount,
    };
  });

  console.log("========================================================================================");
  console.log(
    `MineBench Global Bradley-Terry Leaderboard (${fittedPublicVotes} eligible public outcomes)`,
  );
  console.log("========================================================================================");
  console.log(
    "Rank | Model                               | Rating | 95% CI   | Interval     | Record (W-L-D)   | Conf | Old Score | Delta",
  );
  console.log(
    "-----+-------------------------------------+--------+----------+--------------+------------------+------+-----------+-------",
  );

  for (const model of rankedModels) {
    const rank = `#${model.rank}`.padEnd(4);
    const name = model.displayName.slice(0, 35).padEnd(35);
    const rating = Math.round(model.rating).toString().padStart(6);
    const ci = `±${model.ci95.toFixed(1)}`.padStart(8);
    const interval = `[${model.ciLower}, ${model.ciUpper}]`.padStart(12);
    const record = `${model.counters.winCount}-${model.counters.lossCount}-${model.counters.drawCount}`.padStart(16);
    const confidence = `${model.confidence}%`.padStart(4);
    const oldScore = Math.round(model.oldConservative).toString().padStart(9);
    const delta = formatDelta(model.rating - model.oldConservative).padStart(6);
    console.log(
      `${rank} | ${name} | ${rating} | ${ci} | ${interval} | ${record} | ${confidence} | ${oldScore} | ${delta}`,
    );
  }
  console.log("========================================================================================");
  console.log(`Public votes replayed: ${publicVotesReplayed}`);
  console.log(`Private votes replayed: ${privateVotesReplayed}`);
  for (const variant of variantDiffs) {
    console.log(
      `- Stealth ${variant.codename}: ${variant.oldConservative.toFixed(2)} -> ${variant.newConservative.toFixed(2)} (${formatDelta(variant.newConservative - variant.oldConservative)})`,
    );
  }

  if (!args.yes) {
    console.log("\nDry run completed. Pass --yes to apply the recomputed values.");
    return;
  }

  const updates = [];
  for (const model of rankedModels) {
    const rating = Math.round(model.rating);
    const standardError = Math.round(model.standardError);
    updates.push(
      prisma.model.update({
        where: { id: model.id },
        data: {
          eloRating: rating,
          glickoRd: standardError,
          conservativeRating: conservativeScore(rating, standardError),
          winCount: model.counters.winCount,
          lossCount: model.counters.lossCount,
          drawCount: model.counters.drawCount,
          bothBadCount: model.counters.bothBadCount,
        },
      }),
    );
  }

  for (const model of models) {
    if (activeModelIdSet.has(model.id)) continue;
    const counters = stateByModelId.get(model.id) as ModelState;
    updates.push(
      prisma.model.update({
        where: { id: model.id },
        data: {
          winCount: counters.winCount,
          lossCount: counters.lossCount,
          drawCount: counters.drawCount,
          bothBadCount: counters.bothBadCount,
        },
      }),
    );
  }

  for (const variant of variantDiffs) {
    updates.push(
      prisma.stealthVariant.update({
        where: { id: variant.id },
        data: {
          eloRating: variant.newRating,
          glickoRd: variant.newRd,
          glickoVolatility: variant.newVolatility,
          conservativeRating: variant.newConservative,
          winCount: variant.winCount,
          lossCount: variant.lossCount,
          drawCount: variant.drawCount,
          bothBadCount: variant.bothBadCount,
        },
      }),
    );
  }

  await prisma.$transaction(updates);

  console.log(
    `\nApplied public ratings and counters to ${models.length} models and ${variants.length} private variants.`,
  );
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
