import { prisma } from "@/lib/prisma";
import { summarizeArenaVotes } from "@/lib/arena/voteMath";
import { confidenceFromRd, conservativeScore, stabilityTier } from "@/lib/arena/rating";

const MIN_PROMPTS_FOR_SPREAD = 3;
const PROMPT_COVERAGE_FLOOR = 2;
const MAX_SPREAD = 0.5;
const RECENT_FORM_WINDOW = 30;
const ARENA_BUILD_GRID_SIZE = 256;
const ARENA_BUILD_PALETTE = "simple";
const ARENA_BUILD_MODE = "precise";
const LEADERBOARD_CACHE_TTL_MS = 20_000;
const MODEL_DETAIL_CACHE_TTL_MS = 20_000;

type NumberLike = number | bigint | string | null;

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

type PromptScoreSample = {
  averageScore: number;
  votes: number;
};

type LeaderboardDispersionRow = {
  modelId: string;
  meanScore: NumberLike;
  scoreVariance: NumberLike;
  scoreSpread: NumberLike;
  coveredPrompts: NumberLike;
  sampledPrompts: NumberLike;
  sampledVotes: NumberLike;
};

type PromptBreakdownRow = {
  promptId: string;
  promptText: string;
  votes: NumberLike;
  averageScore: NumberLike;
  wins: NumberLike;
  losses: NumberLike;
  draws: NumberLike;
  bothBad: NumberLike;
};

type OpponentBreakdownRow = {
  key: string;
  displayName: string;
  votes: NumberLike;
  averageScore: NumberLike;
  wins: NumberLike;
  losses: NumberLike;
  draws: NumberLike;
  bothBad: NumberLike;
};

type RecentScoreRow = {
  score: NumberLike;
};

let leaderboardCache: CachedValue<Map<string, ScoreDispersion>> | null = null;
let leaderboardInFlight: Promise<Map<string, ScoreDispersion>> | null = null;
const modelDetailCache = new Map<string, CachedValue<ModelDetailStats | null>>();
const modelDetailInFlight = new Map<string, Promise<ModelDetailStats | null>>();

export type ScoreDispersion = {
  meanScore: number | null;
  scoreVariance: number | null;
  scoreSpread: number | null;
  consistency: number | null;
  coveredPrompts: number;
  activePrompts: number;
  promptCoverage: number;
  sampledPrompts: number;
  sampledVotes: number;
};

export type ModelPromptBreakdown = {
  promptId: string;
  promptText: string;
  votes: number;
  averageScore: number;
  wins: number;
  losses: number;
  draws: number;
  bothBad: number;
  build: {
    buildId: string;
    gridSize: number;
    palette: "simple" | "advanced";
    mode: string;
    blockCount: number;
  } | null;
};

export type ModelOpponentBreakdown = {
  key: string;
  displayName: string;
  votes: number;
  averageScore: number;
  wins: number;
  losses: number;
  draws: number;
  bothBad: number;
};

export type ModelDetailStats = {
  model: {
    key: string;
    provider: string;
    displayName: string;
    eloRating: number;
    ratingDeviation: number;
    rankScore: number;
    confidence: number;
    stability: "Provisional" | "Established" | "Stable";
    shownCount: number;
    winCount: number;
    lossCount: number;
    drawCount: number;
    bothBadCount: number;
  };
  summary: ScoreDispersion & {
    totalVotes: number;
    decisiveVotes: number;
    winRate: number | null;
    recentForm: number | null;
    recentDelta: number | null;
    qualityFloorScore: number | null;
  };
  prompts: ModelPromptBreakdown[];
  opponents: ModelOpponentBreakdown[];
};

function toNumber(value: NumberLike, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeGridSize(value: number): 64 | 256 | 512 {
  if (value === 64 || value === 256 || value === 512) return value;
  return ARENA_BUILD_GRID_SIZE;
}

function normalizePalette(value: string): "simple" | "advanced" {
  return value === "advanced" ? "advanced" : "simple";
}

function summarizeDispersion(samples: PromptScoreSample[], activePromptCount: number): ScoreDispersion {
  const promptAverages: number[] = [];
  let sampledVotes = 0;
  let coveredPrompts = 0;

  for (const sample of samples) {
    if (sample.votes <= 0) continue;
    promptAverages.push(sample.averageScore);
    sampledVotes += sample.votes;
    if (sample.votes >= PROMPT_COVERAGE_FLOOR) {
      coveredPrompts += 1;
    }
  }

  const sampledPrompts = promptAverages.length;
  const promptCoverage =
    activePromptCount > 0 ? Math.min(1, coveredPrompts / activePromptCount) : 0;
  if (sampledPrompts === 0) {
    return {
      meanScore: null,
      scoreVariance: null,
      scoreSpread: null,
      consistency: null,
      coveredPrompts,
      activePrompts: activePromptCount,
      promptCoverage,
      sampledPrompts: 0,
      sampledVotes: 0,
    };
  }

  const meanScore = promptAverages.reduce((sum, value) => sum + value, 0) / sampledPrompts;

  if (sampledPrompts < MIN_PROMPTS_FOR_SPREAD) {
    return {
      meanScore,
      scoreVariance: null,
      scoreSpread: null,
      consistency: null,
      coveredPrompts,
      activePrompts: activePromptCount,
      promptCoverage,
      sampledPrompts,
      sampledVotes,
    };
  }

  const scoreVariance =
    promptAverages.reduce((sum, value) => sum + (value - meanScore) ** 2, 0) / sampledPrompts;
  const scoreSpread = Math.sqrt(scoreVariance);
  const consistency = Math.round((1 - Math.min(MAX_SPREAD, scoreSpread) / MAX_SPREAD) * 100);

  return {
    meanScore,
    scoreVariance,
    scoreSpread,
    consistency,
    coveredPrompts,
    activePrompts: activePromptCount,
    promptCoverage,
    sampledPrompts,
    sampledVotes,
  };
}

export function invalidateArenaStatsCache() {
  leaderboardCache = null;
  modelDetailCache.clear();
}

async function queryLeaderboardDispersionByModelId(): Promise<Map<string, ScoreDispersion>> {
  const [activePromptCount, rows] = await Promise.all([
    prisma.prompt.count({ where: { active: true } }),
    prisma.$queryRaw<LeaderboardDispersionRow[]>`
      WITH model_prompt_scores AS (
        SELECT
          matchup."modelAId" AS model_id,
          matchup."promptId" AS prompt_id,
          CASE vote.choice
            WHEN 'A' THEN 1.0
            WHEN 'B' THEN 0.0
            WHEN 'TIE' THEN 0.5
            ELSE NULL
          END AS score
        FROM "Vote" vote
        INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
        WHERE vote.choice IN ('A', 'B', 'TIE')

        UNION ALL

        SELECT
          matchup."modelBId" AS model_id,
          matchup."promptId" AS prompt_id,
          CASE vote.choice
            WHEN 'A' THEN 0.0
            WHEN 'B' THEN 1.0
            WHEN 'TIE' THEN 0.5
            ELSE NULL
          END AS score
        FROM "Vote" vote
        INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
        WHERE vote.choice IN ('A', 'B', 'TIE')
      ),
      per_prompt AS (
        SELECT
          model_prompt_scores.model_id AS "modelId",
          model_prompt_scores.prompt_id AS "promptId",
          AVG(model_prompt_scores.score)::double precision AS "promptAverage",
          COUNT(*)::int AS "promptVotes"
        FROM model_prompt_scores
        GROUP BY model_prompt_scores.model_id, model_prompt_scores.prompt_id
      )
      SELECT
        per_prompt."modelId" AS "modelId",
        AVG(per_prompt."promptAverage")::double precision AS "meanScore",
        CASE
          WHEN COUNT(*) >= ${MIN_PROMPTS_FOR_SPREAD}
          THEN VAR_POP(per_prompt."promptAverage")::double precision
          ELSE NULL
        END AS "scoreVariance",
        CASE
          WHEN COUNT(*) >= ${MIN_PROMPTS_FOR_SPREAD}
          THEN SQRT(VAR_POP(per_prompt."promptAverage"))::double precision
          ELSE NULL
        END AS "scoreSpread",
        COUNT(*) FILTER (WHERE per_prompt."promptVotes" >= ${PROMPT_COVERAGE_FLOOR})::int AS "coveredPrompts",
        COUNT(*)::int AS "sampledPrompts",
        COALESCE(SUM(per_prompt."promptVotes"), 0)::int AS "sampledVotes"
      FROM per_prompt
      GROUP BY per_prompt."modelId"
    `,
  ]);

  const out = new Map<string, ScoreDispersion>();
  for (const row of rows) {
    const scoreSpreadRaw = row.scoreSpread == null ? null : toNumber(row.scoreSpread);
    const coveredPrompts = toNumber(row.coveredPrompts);
    const promptCoverage =
      activePromptCount > 0 ? Math.min(1, coveredPrompts / activePromptCount) : 0;
    out.set(row.modelId, {
      meanScore: row.meanScore == null ? null : toNumber(row.meanScore),
      scoreVariance: row.scoreVariance == null ? null : toNumber(row.scoreVariance),
      scoreSpread: scoreSpreadRaw,
      consistency:
        scoreSpreadRaw == null
          ? null
          : Math.round((1 - Math.min(MAX_SPREAD, scoreSpreadRaw) / MAX_SPREAD) * 100),
      coveredPrompts,
      activePrompts: activePromptCount,
      promptCoverage,
      sampledPrompts: toNumber(row.sampledPrompts),
      sampledVotes: toNumber(row.sampledVotes),
    });
  }

  return out;
}

export async function getLeaderboardDispersionByModelId(): Promise<Map<string, ScoreDispersion>> {
  const now = Date.now();
  if (leaderboardCache && leaderboardCache.expiresAt > now) {
    return leaderboardCache.value;
  }
  if (leaderboardInFlight) {
    return leaderboardInFlight;
  }

  leaderboardInFlight = queryLeaderboardDispersionByModelId()
    .then((value) => {
      leaderboardCache = {
        value,
        expiresAt: Date.now() + LEADERBOARD_CACHE_TTL_MS,
      };
      return value;
    })
    .finally(() => {
      leaderboardInFlight = null;
    });

  return leaderboardInFlight;
}

async function queryModelDetailStats(modelKey: string): Promise<ModelDetailStats | null> {
  const model = await prisma.model.findFirst({
    where: { key: modelKey, enabled: true, isBaseline: false },
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
  });

  if (!model) return null;

  const [promptRows, opponentRows, recentScoreRows, builds, activePromptCount] = await Promise.all([
    prisma.$queryRaw<PromptBreakdownRow[]>`
      SELECT
        matchup."promptId" AS "promptId",
        prompt.text AS "promptText",
        COUNT(*) FILTER (WHERE vote.choice IN ('A', 'B', 'TIE'))::int AS "votes",
        COALESCE(
          AVG(
            CASE
              WHEN matchup."modelAId" = ${model.id} THEN
                CASE vote.choice
                  WHEN 'A' THEN 1.0
                  WHEN 'B' THEN 0.0
                  WHEN 'TIE' THEN 0.5
                  ELSE NULL
                END
              ELSE
                CASE vote.choice
                  WHEN 'A' THEN 0.0
                  WHEN 'B' THEN 1.0
                  WHEN 'TIE' THEN 0.5
                  ELSE NULL
                END
            END
          ),
          0
        )::double precision AS "averageScore",
        COUNT(*) FILTER (
          WHERE (matchup."modelAId" = ${model.id} AND vote.choice = 'A')
             OR (matchup."modelBId" = ${model.id} AND vote.choice = 'B')
        )::int AS "wins",
        COUNT(*) FILTER (
          WHERE (matchup."modelAId" = ${model.id} AND vote.choice = 'B')
             OR (matchup."modelBId" = ${model.id} AND vote.choice = 'A')
        )::int AS "losses",
        COUNT(*) FILTER (WHERE vote.choice = 'TIE')::int AS "draws",
        COUNT(*) FILTER (WHERE vote.choice = 'BOTH_BAD')::int AS "bothBad"
      FROM "Vote" vote
      INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
      INNER JOIN "Prompt" prompt ON prompt.id = matchup."promptId"
      WHERE matchup."modelAId" = ${model.id} OR matchup."modelBId" = ${model.id}
      GROUP BY matchup."promptId", prompt.text
    `,
    prisma.$queryRaw<OpponentBreakdownRow[]>`
      SELECT
        opponent.key AS key,
        opponent."displayName" AS "displayName",
        COUNT(*) FILTER (WHERE vote.choice IN ('A', 'B', 'TIE'))::int AS "votes",
        COALESCE(
          AVG(
            CASE
              WHEN matchup."modelAId" = ${model.id} THEN
                CASE vote.choice
                  WHEN 'A' THEN 1.0
                  WHEN 'B' THEN 0.0
                  WHEN 'TIE' THEN 0.5
                  ELSE NULL
                END
              ELSE
                CASE vote.choice
                  WHEN 'A' THEN 0.0
                  WHEN 'B' THEN 1.0
                  WHEN 'TIE' THEN 0.5
                  ELSE NULL
                END
            END
          ),
          0
        )::double precision AS "averageScore",
        COUNT(*) FILTER (
          WHERE (matchup."modelAId" = ${model.id} AND vote.choice = 'A')
             OR (matchup."modelBId" = ${model.id} AND vote.choice = 'B')
        )::int AS "wins",
        COUNT(*) FILTER (
          WHERE (matchup."modelAId" = ${model.id} AND vote.choice = 'B')
             OR (matchup."modelBId" = ${model.id} AND vote.choice = 'A')
        )::int AS "losses",
        COUNT(*) FILTER (WHERE vote.choice = 'TIE')::int AS "draws",
        COUNT(*) FILTER (WHERE vote.choice = 'BOTH_BAD')::int AS "bothBad"
      FROM "Vote" vote
      INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
      INNER JOIN "Model" opponent
        ON opponent.id = CASE
          WHEN matchup."modelAId" = ${model.id} THEN matchup."modelBId"
          ELSE matchup."modelAId"
        END
      WHERE matchup."modelAId" = ${model.id} OR matchup."modelBId" = ${model.id}
      GROUP BY opponent.id, opponent.key, opponent."displayName"
    `,
    prisma.$queryRaw<RecentScoreRow[]>`
      SELECT
        CASE
          WHEN matchup."modelAId" = ${model.id} THEN
            CASE vote.choice
              WHEN 'A' THEN 1.0
              WHEN 'B' THEN 0.0
              WHEN 'TIE' THEN 0.5
              ELSE NULL
            END
          ELSE
            CASE vote.choice
              WHEN 'A' THEN 0.0
              WHEN 'B' THEN 1.0
              WHEN 'TIE' THEN 0.5
              ELSE NULL
            END
        END::double precision AS score
      FROM "Vote" vote
      INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
      WHERE (matchup."modelAId" = ${model.id} OR matchup."modelBId" = ${model.id})
        AND vote.choice IN ('A', 'B', 'TIE')
      ORDER BY vote."createdAt" DESC
      LIMIT ${RECENT_FORM_WINDOW * 2}
    `,
    prisma.build.findMany({
      where: {
        modelId: model.id,
        gridSize: ARENA_BUILD_GRID_SIZE,
        palette: ARENA_BUILD_PALETTE,
        mode: ARENA_BUILD_MODE,
      },
      select: {
        id: true,
        promptId: true,
        gridSize: true,
        palette: true,
        mode: true,
        blockCount: true,
        prompt: {
          select: { text: true },
        },
      },
    }),
    prisma.prompt.count({ where: { active: true } }),
  ]);

  const promptSamples: PromptScoreSample[] = [];
  const promptStatsById = new Map<
    string,
    {
      promptText: string;
      votes: number;
      averageScore: number;
      wins: number;
      losses: number;
      draws: number;
      bothBad: number;
    }
  >();

  for (const row of promptRows) {
    const votes = toNumber(row.votes);
    const averageScore = toNumber(row.averageScore);
    promptStatsById.set(row.promptId, {
      promptText: row.promptText,
      votes,
      averageScore,
      wins: toNumber(row.wins),
      losses: toNumber(row.losses),
      draws: toNumber(row.draws),
      bothBad: toNumber(row.bothBad),
    });
    promptSamples.push({ averageScore, votes });
  }

  const dispersion = summarizeDispersion(promptSamples, activePromptCount);

  const buildByPromptId = new Map<
    string,
    {
      promptText: string;
      build: ModelPromptBreakdown["build"];
    }
  >();

  for (const build of builds) {
    const gridSize = normalizeGridSize(build.gridSize);
    const palette = normalizePalette(build.palette);

    buildByPromptId.set(build.promptId, {
      promptText: build.prompt.text,
      build: {
        buildId: build.id,
        gridSize,
        palette,
        mode: build.mode,
        blockCount: build.blockCount,
      },
    });
  }

  const allPromptIds = new Set<string>([
    ...promptStatsById.keys(),
    ...buildByPromptId.keys(),
  ]);

  const prompts: ModelPromptBreakdown[] = Array.from(allPromptIds)
    .map((promptId) => {
      const promptStats = promptStatsById.get(promptId);
      const buildEntry = buildByPromptId.get(promptId);
      return {
        promptId,
        promptText:
          promptStats?.promptText ?? buildEntry?.promptText ?? "Untitled prompt",
        votes: promptStats?.votes ?? 0,
        averageScore: promptStats?.averageScore ?? 0,
        wins: promptStats?.wins ?? 0,
        losses: promptStats?.losses ?? 0,
        draws: promptStats?.draws ?? 0,
        bothBad: promptStats?.bothBad ?? 0,
        build: buildEntry?.build ?? null,
      };
    })
    .sort((a, b) => b.votes - a.votes || b.averageScore - a.averageScore);

  const opponents: ModelOpponentBreakdown[] = opponentRows
    .map((row) => ({
      key: row.key,
      displayName: row.displayName,
      votes: toNumber(row.votes),
      averageScore: toNumber(row.averageScore),
      wins: toNumber(row.wins),
      losses: toNumber(row.losses),
      draws: toNumber(row.draws),
      bothBad: toNumber(row.bothBad),
    }))
    .sort((a, b) => b.votes - a.votes || b.averageScore - a.averageScore);

  const voteScores = recentScoreRows
    .map((row) => toNumber(row.score, Number.NaN))
    .filter((score) => Number.isFinite(score));
  const recentScores = voteScores.slice(0, RECENT_FORM_WINDOW);
  const priorScores = voteScores.slice(RECENT_FORM_WINDOW, RECENT_FORM_WINDOW * 2);
  const recentForm = average(recentScores);
  const priorForm = average(priorScores);

  const { decisiveVotes, totalVotes } = summarizeArenaVotes(model);
  const ratingDeviation = Number(model.glickoRd);
  const rawRating = Number(model.eloRating);
  const rankScore = Number(model.conservativeRating ?? conservativeScore(rawRating, ratingDeviation));
  const confidence = confidenceFromRd(ratingDeviation);
  const stability = stabilityTier({
    decisiveVotes,
    promptCoverage: dispersion.promptCoverage,
    rd: ratingDeviation,
  });
  const qualityFloorScore =
    totalVotes > 0 ? Math.max(0, 1 - model.bothBadCount / totalVotes) : null;

  return {
    model: {
      key: model.key,
      provider: model.provider,
      displayName: model.displayName,
      eloRating: rawRating,
      ratingDeviation,
      rankScore,
      confidence,
      stability,
      shownCount: model.shownCount,
      winCount: model.winCount,
      lossCount: model.lossCount,
      drawCount: model.drawCount,
      bothBadCount: model.bothBadCount,
    },
    summary: {
      ...dispersion,
      totalVotes,
      decisiveVotes,
      winRate: decisiveVotes > 0 ? model.winCount / decisiveVotes : null,
      recentForm,
      recentDelta:
        recentForm != null && priorForm != null ? recentForm - priorForm : null,
      qualityFloorScore,
    },
    prompts,
    opponents,
  };
}

export async function getModelDetailStats(modelKey: string): Promise<ModelDetailStats | null> {
  const now = Date.now();
  const cached = modelDetailCache.get(modelKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = modelDetailInFlight.get(modelKey);
  if (inFlight) {
    return inFlight;
  }

  const queryPromise = queryModelDetailStats(modelKey)
    .then((value) => {
      modelDetailCache.set(modelKey, {
        value,
        expiresAt: Date.now() + MODEL_DETAIL_CACHE_TTL_MS,
      });
      return value;
    })
    .finally(() => {
      modelDetailInFlight.delete(modelKey);
    });

  modelDetailInFlight.set(modelKey, queryPromise);
  return queryPromise;
}
