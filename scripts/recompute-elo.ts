#!/usr/bin/env npx tsx
/**
 * Recompute Arena rating + vote counters from stored vote history.
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
  conservativeScore,
  updateRatingPair,
} from "../lib/arena/rating";

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
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Recompute MineBench Arena rating + counters from vote history.

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
            modelAId: true,
            modelBId: true,
          },
        },
      },
    }),
  ]);

  const stateByModelId = new Map<string, ModelState>();
  for (const model of models) {
    stateByModelId.set(model.id, {
      rating: INITIAL_RATING,
      rd: INITIAL_RD,
      volatility: INITIAL_VOLATILITY,
      winCount: 0,
      lossCount: 0,
      drawCount: 0,
      bothBadCount: 0,
    });
  }

  for (const vote of votes) {
    if (!isChoice(vote.choice)) continue;
    const a = stateByModelId.get(vote.matchup.modelAId);
    const b = stateByModelId.get(vote.matchup.modelBId);
    if (!a || !b) continue;

    if (vote.choice === "BOTH_BAD") {
      a.bothBadCount += 1;
      b.bothBadCount += 1;
      continue;
    }

    const outcome = vote.choice === "A" ? "A_WIN" : vote.choice === "B" ? "B_WIN" : "DRAW";
    const updated = updateRatingPair({
      a: { rating: a.rating, rd: a.rd, volatility: a.volatility },
      b: { rating: b.rating, rd: b.rd, volatility: b.volatility },
      outcome,
    });

    a.rating = updated.a.rating;
    a.rd = updated.a.rd;
    a.volatility = updated.a.volatility;
    b.rating = updated.b.rating;
    b.rd = updated.b.rd;
    b.volatility = updated.b.volatility;

    if (outcome === "A_WIN") {
      a.winCount += 1;
      b.lossCount += 1;
    } else if (outcome === "B_WIN") {
      a.lossCount += 1;
      b.winCount += 1;
    } else {
      a.drawCount += 1;
      b.drawCount += 1;
    }
  }

  const diffs = models
    .map((model) => {
      const recomputed = stateByModelId.get(model.id);
      if (!recomputed) return null;
      return {
        id: model.id,
        key: model.key,
        displayName: model.displayName,
        oldRating: Number(model.eloRating),
        newRating: recomputed.rating,
        oldRd: Number(model.glickoRd),
        newRd: recomputed.rd,
        oldVolatility: Number(model.glickoVolatility),
        newVolatility: recomputed.volatility,
        oldConservative: Number(model.conservativeRating),
        newConservative: conservativeScore(recomputed.rating, recomputed.rd),
        oldWinCount: model.winCount,
        newWinCount: recomputed.winCount,
        oldLossCount: model.lossCount,
        newLossCount: recomputed.lossCount,
        oldDrawCount: model.drawCount,
        newDrawCount: recomputed.drawCount,
        oldBothBadCount: model.bothBadCount,
        newBothBadCount: recomputed.bothBadCount,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null)
    .sort(
      (a, b) =>
        Math.abs(b.newConservative - b.oldConservative) -
        Math.abs(a.newConservative - a.oldConservative),
    );

  console.log(`models: ${models.length}`);
  console.log(`votes replayed: ${votes.length}`);
  console.log("top conservative-score deltas:");
  for (const diff of diffs.slice(0, 10)) {
    console.log(
      `- ${diff.displayName} (${diff.key}): ${diff.oldConservative.toFixed(2)} -> ${diff.newConservative.toFixed(2)} (${formatDelta(diff.newConservative - diff.oldConservative)})`,
    );
  }

  if (!args.yes) {
    console.log("dry run: pass --yes to apply");
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const diff of diffs) {
      await tx.model.update({
        where: { id: diff.id },
        data: {
          eloRating: diff.newRating,
          glickoRd: diff.newRd,
          glickoVolatility: diff.newVolatility,
          conservativeRating: diff.newConservative,
          winCount: diff.newWinCount,
          lossCount: diff.newLossCount,
          drawCount: diff.newDrawCount,
          bothBadCount: diff.newBothBadCount,
        },
      });
    }
  });

  console.log("done");
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));

