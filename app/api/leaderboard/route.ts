import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { LeaderboardResponse } from "@/lib/arena/types";
import { getLeaderboardDispersionByModelId } from "@/lib/arena/stats";
import { confidenceFromRd, conservativeScore, stabilityTier } from "@/lib/arena/rating";
import { summarizeArenaVotes } from "@/lib/arena/voteMath";
import { getArenaEligiblePromptIds } from "@/lib/arena/eligibility";
import { getArenaPairCoverageByKey } from "@/lib/arena/coverage";
import { ServerTiming } from "@/lib/serverTiming";

export const runtime = "nodejs";

const CONTENDER_BAND_SIZE = 8;
const ADJ_PAIR_VOTES_FLOOR = 12;
const ADJ_PAIR_PROMPTS_FLOOR = 6;
const MOVEMENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MOVEMENT_CONFIDENCE_FLOOR = 50;

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
  const timing = new ServerTiming();
  const requestStartedAt = timing.start();
  const movementAnchorTime = new Date(Date.now() - MOVEMENT_LOOKBACK_MS);
  const [models, dispersionByModelId, eligiblePromptIds, baselineAnchor] = await Promise.all([
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
    getArenaEligiblePromptIds(),
    prisma.modelRankSnapshot.findFirst({
      where: { capturedAt: { lte: movementAnchorTime } },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true },
    }),
  ]);
  const eligiblePromptCount = eligiblePromptIds.length;
  const hasGlobalBaseline = Boolean(baselineAnchor);

  let baselineRanksByModelId = new Map<string, number>();
  if (baselineAnchor) {
    const rows = await prisma.modelRankSnapshot.findMany({
      where: { capturedAt: baselineAnchor.capturedAt },
      select: { modelId: true, rank: true },
    });
    baselineRanksByModelId = new Map(rows.map((row) => [row.modelId, row.rank]));
  }

  const topBandIds = models.slice(0, CONTENDER_BAND_SIZE).map((m) => m.id);
  let pairCoverageByKey = new Map<string, PairCoverage>();

  if (topBandIds.length >= 2 && eligiblePromptIds.length > 0) {
    pairCoverageByKey = await getArenaPairCoverageByKey(topBandIds, eligiblePromptIds);
  }

  const body: LeaderboardResponse = {
    models: models.map((m, index) => {
      const dispersion = dispersionByModelId.get(m.id) ?? {
        meanScore: null,
        scoreVariance: null,
        scoreSpread: null,
        consistency: null,
        coveredPrompts: 0,
        activePrompts: eligiblePromptCount,
        promptCoverage: 0,
        sampledPrompts: 0,
        sampledVotes: 0,
      };

      const rawRating = Number(m.eloRating);
      const ratingDeviation = Number(m.glickoRd);
      const rankScore = Number(m.conservativeRating ?? conservativeScore(rawRating, ratingDeviation));
      const confidence = confidenceFromRd(ratingDeviation);
      const rank = index + 1;
      const baselineRank = baselineRanksByModelId.get(m.id);
      const hasBaseline24h = hasGlobalBaseline && baselineRank != null;
      const rankDelta24h = hasBaseline24h ? baselineRank - rank : null;
      const movementVisible = hasGlobalBaseline && confidence >= MOVEMENT_CONFIDENCE_FLOOR;
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
        rank,
        rankDelta24h,
        hasBaseline24h,
        movementVisible,
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

  timing.end("total", requestStartedAt);
  // edge cache absorbs the burst; vote drain invalidates stats and the next miss recomputes.
  // s-maxage governs Vercel CDN, max-age=0 keeps browsers from holding stale rankings.
  const headers = new Headers({
    "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
  });
  timing.apply(headers);
  return NextResponse.json(body, { headers });
}
