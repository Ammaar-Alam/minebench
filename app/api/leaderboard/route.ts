import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { LeaderboardResponse } from "@/lib/arena/types";
import { getLeaderboardDispersionByModelId } from "@/lib/arena/stats";
import { confidenceFromRd, conservativeScore, stabilityTier } from "@/lib/arena/rating";
import { summarizeArenaVotes } from "@/lib/arena/voteMath";

export const runtime = "nodejs";

const CONTENDER_BAND_SIZE = 8;
const ADJ_PAIR_VOTES_FLOOR = 12;
const ADJ_PAIR_PROMPTS_FLOOR = 6;

type PairCoverageRow = {
  modelLowId: string;
  modelHighId: string;
  decisiveVotes: number;
  promptCount: number;
};

type PairCoverage = {
  decisiveVotes: number;
  promptCount: number;
};

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairCompletion(coverage: PairCoverage | null): number {
  if (!coverage) return 0;
  const votesCompletion = Math.min(1, coverage.decisiveVotes / ADJ_PAIR_VOTES_FLOOR);
  const promptsCompletion = Math.min(1, coverage.promptCount / ADJ_PAIR_PROMPTS_FLOOR);
  return Math.min(votesCompletion, promptsCompletion);
}

export async function GET() {
  const [models, dispersionByModelId] = await Promise.all([
    prisma.model.findMany({
      where: { isBaseline: false, enabled: true },
      orderBy: [{ conservativeRating: "desc" }, { displayName: "asc" }],
      select: {
        id: true,
        key: true,
        provider: true,
        displayName: true,
        eloRating: true,
        glickoRd: true,
        conservativeRating: true,
        shownCount: true,
        winCount: true,
        lossCount: true,
        drawCount: true,
        bothBadCount: true,
      },
    }),
    getLeaderboardDispersionByModelId(),
  ]);

  const topBandIds = models.slice(0, CONTENDER_BAND_SIZE).map((m) => m.id);
  let pairCoverageByKey = new Map<string, PairCoverage>();

  if (topBandIds.length >= 2) {
    const idList = Prisma.join(topBandIds);
    const pairRows = await prisma.$queryRaw<PairCoverageRow[]>`
      SELECT
        LEAST(matchup."modelAId", matchup."modelBId") AS "modelLowId",
        GREATEST(matchup."modelAId", matchup."modelBId") AS "modelHighId",
        COUNT(*)::int AS "decisiveVotes",
        COUNT(DISTINCT matchup."promptId")::int AS "promptCount"
      FROM "Vote" vote
      INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
      WHERE vote.choice IN ('A', 'B')
        AND matchup."modelAId" IN (${idList})
        AND matchup."modelBId" IN (${idList})
      GROUP BY LEAST(matchup."modelAId", matchup."modelBId"), GREATEST(matchup."modelAId", matchup."modelBId")
    `;

    pairCoverageByKey = new Map(
      pairRows.map((row) => [
        pairKey(row.modelLowId, row.modelHighId),
        { decisiveVotes: Number(row.decisiveVotes), promptCount: Number(row.promptCount) },
      ]),
    );
  }

  const body: LeaderboardResponse = {
    models: models.map((m, index) => {
      const dispersion = dispersionByModelId.get(m.id) ?? {
        meanScore: null,
        scoreVariance: null,
        scoreSpread: null,
        consistency: null,
        coveredPrompts: 0,
        activePrompts: 0,
        promptCoverage: 0,
        sampledPrompts: 0,
        sampledVotes: 0,
      };

      const rawRating = Number(m.eloRating);
      const ratingDeviation = Number(m.glickoRd);
      const rankScore = Number(m.conservativeRating ?? conservativeScore(rawRating, ratingDeviation));
      const confidence = confidenceFromRd(ratingDeviation);
      const voteSummary = summarizeArenaVotes(m);
      const qualityFloorScore =
        voteSummary.totalVotes > 0
          ? Math.max(0, 1 - m.bothBadCount / voteSummary.totalVotes)
          : null;
      const stability = stabilityTier({
        decisiveVotes: voteSummary.decisiveVotes,
        promptCoverage: dispersion.promptCoverage,
        rd: ratingDeviation,
      });

      let pairCoverageScore: number | null = null;
      if (index < topBandIds.length) {
        const neighborIndices = [index - 1, index + 1].filter(
          (neighborIndex) => neighborIndex >= 0 && neighborIndex < topBandIds.length,
        );
        if (neighborIndices.length > 0) {
          const completions = neighborIndices.map((neighborIndex) => {
            const neighborId = topBandIds[neighborIndex];
            return pairCompletion(pairCoverageByKey.get(pairKey(m.id, neighborId)) ?? null);
          });
          pairCoverageScore = Math.round(
            (completions.reduce((sum, value) => sum + value, 0) / completions.length) * 100,
          );
        }
      }

      return {
        key: m.key,
        provider: m.provider,
        displayName: m.displayName,
        stability,
        eloRating: rawRating,
        ratingDeviation,
        rankScore,
        confidence,
        shownCount: m.shownCount,
        winCount: m.winCount,
        lossCount: m.lossCount,
        drawCount: m.drawCount,
        bothBadCount: m.bothBadCount,
        coveredPrompts: dispersion.coveredPrompts,
        activePrompts: dispersion.activePrompts,
        promptCoverage: dispersion.promptCoverage,
        pairCoverageScore,
        qualityFloorScore,
        meanScore: dispersion.meanScore,
        scoreVariance: dispersion.scoreVariance,
        scoreSpread: dispersion.scoreSpread,
        consistency: dispersion.consistency,
        sampledPrompts: dispersion.sampledPrompts,
        sampledVotes: dispersion.sampledVotes,
      };
    }),
  };

  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

