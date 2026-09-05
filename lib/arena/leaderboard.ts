import type { Prisma } from "@prisma/client";
import { getCache } from "@vercel/functions";
import {
  getAverageBenchmarkCostPerBuildUsd,
  getAverageBenchmarkInferenceTimeMs,
  getModelBenchmarkProfile,
} from "@/lib/ai/modelBenchmarkProfiles";
import { resolveModelDisplayName, resolveModelSlug } from "@/lib/ai/modelCatalog";
import { getArenaPairCoverageByKey } from "@/lib/arena/coverage";
import {
  arenaCohortBuildWhere,
  getArenaEligiblePromptIds,
} from "@/lib/arena/eligibility";
import { confidenceFromRd, stabilityTier } from "@/lib/arena/rating";
import {
  getGlobalBradleyTerrySnapshot,
  getLeaderboardDispersionByModelId,
} from "@/lib/arena/stats";
import type { LeaderboardModelBenchmark, LeaderboardResponse } from "@/lib/arena/types";
import { summarizeArenaVotes } from "@/lib/arena/voteMath";
import { prisma } from "@/lib/prisma";

const CONTENDER_BAND_SIZE = 8;
const ADJ_PAIR_VOTES_FLOOR = 12;
const ADJ_PAIR_PROMPTS_FLOOR = 6;
const MOVEMENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MOVEMENT_CONFIDENCE_FLOOR = 50;
const BRADLEY_TERRY_SNAPSHOT_EPOCH = new Date("2026-08-25T00:00:00.000Z");
const LEADERBOARD_RUNTIME_CACHE_KEY = "response-v2";
const LEADERBOARD_RUNTIME_CACHE_TTL_SECONDS = 30;

type PairCoverage = {
  decisiveVotes: number;
  promptCount: number;
};

type LeaderboardBenchmarkBlockSummary = {
  averageBlocks: number | null;
  blockSampleCount: number;
};

const LEADERBOARD_MODEL_SELECT = {
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
} satisfies Prisma.ModelSelect;

type LeaderboardDataSource = "computed" | "inflight" | "runtime-cache";

export type LeaderboardDataResult = {
  data: LeaderboardResponse;
  source: LeaderboardDataSource;
};

const runtimeCache = process.env.VERCEL
  ? getCache({ namespace: "minebench-leaderboard" })
  : null;
let leaderboardInFlight: Promise<LeaderboardResponse> | null = null;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairCompletion(coverage: PairCoverage | null): number {
  if (!coverage) return 0;
  const votesCompletion = Math.min(1, coverage.decisiveVotes / ADJ_PAIR_VOTES_FLOOR);
  const promptsCompletion = Math.min(1, coverage.promptCount / ADJ_PAIR_PROMPTS_FLOOR);
  return Math.min(votesCompletion, promptsCompletion);
}

export function createLeaderboardBenchmark(
  modelKey: string,
  expectedBuildCount: number,
  blockSummary?: LeaderboardBenchmarkBlockSummary,
): LeaderboardModelBenchmark {
  const profile = getModelBenchmarkProfile(modelKey);
  const benchmark: LeaderboardModelBenchmark = {
    averageCostUsd: getAverageBenchmarkCostPerBuildUsd(modelKey),
    costEstimated: Boolean(profile?.totalCost?.estimated),
    averageTimeMs: getAverageBenchmarkInferenceTimeMs(modelKey),
    averageBlocks:
      expectedBuildCount > 0 && blockSummary?.blockSampleCount === expectedBuildCount && (blockSummary.averageBlocks ?? 0) > 0
        ? blockSummary.averageBlocks
        : null,
    blockSampleCount: blockSummary?.blockSampleCount ?? 0,
    expectedBuildCount,
  };
  return profile?.note ? { ...benchmark, note: profile.note } : benchmark;
}

async function getLeaderboardBenchmarkBlocksByModelId(
  eligiblePromptIds: readonly string[],
): Promise<Map<string, LeaderboardBenchmarkBlockSummary>> {
  if (eligiblePromptIds.length === 0) return new Map();

  const where = {
    ...arenaCohortBuildWhere(),
    promptId: { in: [...eligiblePromptIds] },
    blockCount: { gt: 0 },
  } satisfies Prisma.BuildWhereInput;

  const rows = await prisma.build.groupBy({
    by: ["modelId"],
    where,
    _avg: { blockCount: true },
    _count: { _all: true },
  });

  return new Map(
    rows.map((row) => [
      row.modelId,
      {
        averageBlocks:
          typeof row._avg.blockCount === "number" ? row._avg.blockCount : null,
        blockSampleCount: row._count._all,
      },
    ]),
  );
}

function isLeaderboardResponse(value: unknown): value is LeaderboardResponse {
  if (!value || typeof value !== "object") return false;
  const models = (value as { models?: unknown }).models;
  return (
    Array.isArray(models) &&
    models.every(
      (model) =>
        model != null &&
        typeof model === "object" &&
        typeof (model as { key?: unknown }).key === "string" &&
        typeof (model as { displayName?: unknown }).displayName === "string" &&
        typeof (model as { rankScore?: unknown }).rankScore === "number",
    )
  );
}

async function readRuntimeCache(): Promise<LeaderboardResponse | null> {
  if (!runtimeCache) return null;
  try {
    const value = await runtimeCache.get(LEADERBOARD_RUNTIME_CACHE_KEY);
    return isLeaderboardResponse(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeRuntimeCache(data: LeaderboardResponse): Promise<void> {
  if (!runtimeCache) return;
  try {
    await runtimeCache.set(LEADERBOARD_RUNTIME_CACHE_KEY, data, {
      name: "Public leaderboard response",
      tags: ["leaderboard"],
      ttl: LEADERBOARD_RUNTIME_CACHE_TTL_SECONDS,
    });
  } catch {
    // Cache availability must not gate the public leaderboard
  }
}

async function queryLeaderboardData(): Promise<LeaderboardResponse> {
  const movementAnchorTime = new Date(Date.now() - MOVEMENT_LOOKBACK_MS);
  const [models, dispersionByModelId, btSnapshot, eligiblePromptIds, baselineAnchor] =
    await Promise.all([
      prisma.model.findMany({
        where: { isBaseline: false, enabled: true, stealthVariant: null },
        select: LEADERBOARD_MODEL_SELECT,
      }),
      getLeaderboardDispersionByModelId(),
      getGlobalBradleyTerrySnapshot(),
      getArenaEligiblePromptIds(),
      prisma.modelRankSnapshot.findFirst({
        where: {
          capturedAt: {
            gte: BRADLEY_TERRY_SNAPSHOT_EPOCH,
            lte: movementAnchorTime,
          },
        },
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true },
      }),
    ]);
  const eligiblePromptCount = eligiblePromptIds.length;
  const hasGlobalBaseline = Boolean(baselineAnchor);

  const sortedModels = [...models].sort((a, b) => {
    const btA = btSnapshot.byModelId.get(a.id);
    const btB = btSnapshot.byModelId.get(b.id);
    const ratingA = btA?.rating ?? Number(a.eloRating);
    const ratingB = btB?.rating ?? Number(b.eloRating);
    return ratingB - ratingA || a.displayName.localeCompare(b.displayName);
  });
  const topBandIds = sortedModels.slice(0, CONTENDER_BAND_SIZE).map((model) => model.id);

  const [baselineRows, pairCoverageByKey, benchmarkBlocksByModelId] = await Promise.all([
    baselineAnchor
      ? prisma.modelRankSnapshot.findMany({
          where: { capturedAt: baselineAnchor.capturedAt },
          select: { modelId: true, rank: true },
        })
      : Promise.resolve([]),
    topBandIds.length >= 2 && eligiblePromptIds.length > 0
      ? getArenaPairCoverageByKey(topBandIds, eligiblePromptIds)
      : Promise.resolve(new Map<string, PairCoverage>()),
    getLeaderboardBenchmarkBlocksByModelId(eligiblePromptIds),
  ]);
  const baselineRanksByModelId = new Map(
    baselineRows.map((row) => [row.modelId, row.rank]),
  );

  return {
    models: sortedModels.map((model, index) => {
      const dispersion = dispersionByModelId.get(model.id) ?? {
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

      const bt = btSnapshot.byModelId.get(model.id);
      const rawRating = Math.round(bt?.rating ?? Number(model.eloRating));
      const ratingDeviation = Math.round(bt?.standardError ?? Number(model.glickoRd));
      const rankScore = rawRating;
      const ci95 = bt ? Number(bt.ci95.toFixed(1)) : undefined;
      const ciLower = bt ? Math.round(bt.rating - bt.ci95) : undefined;
      const ciUpper = bt ? Math.round(bt.rating + bt.ci95) : undefined;
      const confidence = bt?.confidence ?? confidenceFromRd(ratingDeviation);
      const rank = index + 1;
      const baselineRank = baselineRanksByModelId.get(model.id);
      const hasBaseline24h = hasGlobalBaseline && baselineRank != null;
      const rankDelta24h = hasBaseline24h ? baselineRank - rank : null;
      const movementVisible = hasGlobalBaseline && confidence >= MOVEMENT_CONFIDENCE_FLOOR;
      const voteSummary = summarizeArenaVotes(model);
      const qualityFloorScore =
        voteSummary.totalVotes > 0
          ? Math.max(0, 1 - model.bothBadCount / voteSummary.totalVotes)
          : null;
      const stability = stabilityTier({
        decisiveVotes: voteSummary.decisiveVotes,
        promptCoverage: dispersion.promptCoverage,
        ci95: bt?.ci95,
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
            return pairCompletion(pairCoverageByKey.get(pairKey(model.id, neighborId)) ?? null);
          });
          pairCoverageScore = Math.round(
            (completions.reduce((sum, value) => sum + value, 0) / completions.length) * 100,
          );
        }
      }

      return {
        key: model.key,
        slug: resolveModelSlug(model.key),
        provider: model.provider,
        displayName: resolveModelDisplayName(model.key, model.displayName),
        stability,
        eloRating: rawRating,
        ratingDeviation,
        rankScore,
        ci95,
        ciLower,
        ciUpper,
        confidence,
        rank,
        rankDelta24h,
        hasBaseline24h,
        movementVisible,
        shownCount: model.shownCount,
        winCount: model.winCount,
        lossCount: model.lossCount,
        drawCount: model.drawCount,
        bothBadCount: model.bothBadCount,
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
        benchmark: createLeaderboardBenchmark(
          model.key,
          eligiblePromptCount,
          benchmarkBlocksByModelId.get(model.id),
        ),
      };
    }),
  };
}

export async function getLeaderboardData(): Promise<LeaderboardDataResult> {
  const cached = await readRuntimeCache();
  if (cached) return { data: cached, source: "runtime-cache" };

  if (leaderboardInFlight) {
    return { data: await leaderboardInFlight, source: "inflight" };
  }

  leaderboardInFlight = queryLeaderboardData().then(async (data) => {
    await writeRuntimeCache(data);
    return data;
  });

  try {
    return { data: await leaderboardInFlight, source: "computed" };
  } finally {
    leaderboardInFlight = null;
  }
}
