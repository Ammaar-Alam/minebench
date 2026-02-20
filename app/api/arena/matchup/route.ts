import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { ArenaMatchup } from "@/lib/arena/types";
import { weightedPick } from "@/lib/arena/sampling";
import { expectedScore } from "@/lib/arena/rating";
import { pickInitialBuild, prepareArenaBuild } from "@/lib/arena/buildArtifacts";

export const runtime = "nodejs";

const SESSION_COOKIE = "mb_session";
const ARENA_GRID_SIZE = 256;
const ARENA_PALETTE = "simple";
const ARENA_MODE = "precise";

const PROMPT_COVERAGE_FLOOR = 2;
const CONTENDER_BAND_SIZE = 8;
const ADJ_PAIR_VOTES_FLOOR = 12;
const ADJ_PAIR_PROMPTS_FLOOR = 6;
type Lane = "coverage" | "contender" | "uncertainty" | "exploration";

const LANE_WEIGHTS: Array<{ lane: Lane; weight: number }> = [
  { lane: "coverage", weight: 0.4 },
  { lane: "contender", weight: 0.3 },
  { lane: "uncertainty", weight: 0.2 },
  { lane: "exploration", weight: 0.1 },
];

type NumberLike = number | bigint | string | null;

type EligiblePrompt = {
  id: string;
  text: string;
  modelIds: string[];
};

type EligibleModel = {
  id: string;
  key: string;
  provider: string;
  displayName: string;
  eloRating: number;
  conservativeRating: number;
  ratingDeviation: number;
  shownCount: number;
};

type MatchupChoice = {
  lane: Lane;
  reason: string;
  prompt: EligiblePrompt;
  modelA: EligibleModel;
  modelB: EligibleModel;
};

type ModelPromptCoverageRow = {
  modelId: string;
  promptId: string;
  decisiveVotes: NumberLike;
};

type PairCoverageRow = {
  modelLowId: string;
  modelHighId: string;
  decisiveVotes: NumberLike;
  promptCount: NumberLike;
};

type PairPromptCoverageRow = {
  modelLowId: string;
  modelHighId: string;
  promptId: string;
  decisiveVotes: NumberLike;
};

type CoverageState = {
  modelPromptDecisiveVotes: Map<string, number>;
  pairDecisiveVotes: Map<string, number>;
  pairPromptCounts: Map<string, number>;
  pairPromptDecisiveVotes: Map<string, number>;
  promptCoverageByModelId: Map<string, number>;
  promptDecisiveTotals: Map<string, number>;
};

function toNumber(value: NumberLike, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getOrSetSessionId(res: NextResponse, req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const existing = match?.[1];
  if (existing) return existing;
  const id = crypto.randomUUID();
  res.cookies.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

function randomPick<T>(items: T[]): T | null {
  return items.length ? (items[Math.floor(Math.random() * items.length)] ?? null) : null;
}

function pairKey(modelIdA: string, modelIdB: string): string {
  return modelIdA < modelIdB ? `${modelIdA}|${modelIdB}` : `${modelIdB}|${modelIdA}`;
}

function modelPromptKey(modelId: string, promptId: string): string {
  return `${modelId}|${promptId}`;
}

function pairPromptKey(modelIdA: string, modelIdB: string, promptId: string): string {
  return `${pairKey(modelIdA, modelIdB)}|${promptId}`;
}

function getModelPromptVotes(coverage: CoverageState, modelId: string, promptId: string): number {
  return coverage.modelPromptDecisiveVotes.get(modelPromptKey(modelId, promptId)) ?? 0;
}

function getPairVotes(coverage: CoverageState, modelIdA: string, modelIdB: string): number {
  return coverage.pairDecisiveVotes.get(pairKey(modelIdA, modelIdB)) ?? 0;
}

function getPairPromptCount(coverage: CoverageState, modelIdA: string, modelIdB: string): number {
  return coverage.pairPromptCounts.get(pairKey(modelIdA, modelIdB)) ?? 0;
}

function getPairPromptVotes(
  coverage: CoverageState,
  modelIdA: string,
  modelIdB: string,
  promptId: string,
): number {
  return coverage.pairPromptDecisiveVotes.get(pairPromptKey(modelIdA, modelIdB, promptId)) ?? 0;
}

function chooseLane(): Lane {
  const choice = weightedPick(LANE_WEIGHTS, (lane) => lane.weight);
  return choice?.lane ?? "exploration";
}

function candidateLanes(primary: Lane): Lane[] {
  const fallback: Lane[] = ["coverage", "contender", "uncertainty", "exploration"];
  return [primary, ...fallback.filter((lane) => lane !== primary)];
}

async function getEligiblePromptsAndModels() {
  const rows = await prisma.build.groupBy({
    by: ["promptId", "modelId"],
    where: {
      gridSize: ARENA_GRID_SIZE,
      palette: ARENA_PALETTE,
      mode: ARENA_MODE,
      model: { enabled: true, isBaseline: false },
      prompt: { active: true },
    },
  });

  const modelIdsByPromptId = new Map<string, Set<string>>();
  const promptIdsByModelId = new Map<string, Set<string>>();

  for (const row of rows) {
    const models = modelIdsByPromptId.get(row.promptId) ?? new Set<string>();
    models.add(row.modelId);
    modelIdsByPromptId.set(row.promptId, models);

    const prompts = promptIdsByModelId.get(row.modelId) ?? new Set<string>();
    prompts.add(row.promptId);
    promptIdsByModelId.set(row.modelId, prompts);
  }

  const eligiblePromptIds = Array.from(modelIdsByPromptId.entries())
    .filter(([, modelIds]) => modelIds.size >= 2)
    .map(([promptId]) => promptId);

  if (eligiblePromptIds.length === 0) {
    return {
      prompts: [] as EligiblePrompt[],
      modelsById: new Map<string, EligibleModel>(),
      promptIdsByModelId: new Map<string, Set<string>>(),
    };
  }

  const [prompts, models] = await Promise.all([
    prisma.prompt.findMany({
      where: { id: { in: eligiblePromptIds }, active: true },
      select: { id: true, text: true },
    }),
    prisma.model.findMany({
      where: {
        enabled: true,
        isBaseline: false,
        id: { in: Array.from(promptIdsByModelId.keys()) },
      },
      select: {
        id: true,
        key: true,
        provider: true,
        displayName: true,
        eloRating: true,
        conservativeRating: true,
        glickoRd: true,
        shownCount: true,
      },
    }),
  ]);

  const modelsById = new Map(
    models.map((model) => [
      model.id,
      {
        id: model.id,
        key: model.key,
        provider: model.provider,
        displayName: model.displayName,
        eloRating: Number(model.eloRating),
        conservativeRating: Number(model.conservativeRating),
        ratingDeviation: Number(model.glickoRd),
        shownCount: model.shownCount,
      } satisfies EligibleModel,
    ]),
  );

  const eligiblePrompts: EligiblePrompt[] = prompts
    .map((prompt) => {
      const modelIds = Array.from(modelIdsByPromptId.get(prompt.id) ?? []);
      const filtered = modelIds.filter((modelId) => modelsById.has(modelId));
      return {
        id: prompt.id,
        text: prompt.text,
        modelIds: filtered,
      };
    })
    .filter((prompt) => prompt.modelIds.length >= 2);

  const filteredPromptIdsByModelId = new Map<string, Set<string>>();
  for (const prompt of eligiblePrompts) {
    for (const modelId of prompt.modelIds) {
      const set = filteredPromptIdsByModelId.get(modelId) ?? new Set<string>();
      set.add(prompt.id);
      filteredPromptIdsByModelId.set(modelId, set);
    }
  }

  return {
    prompts: eligiblePrompts,
    modelsById,
    promptIdsByModelId: filteredPromptIdsByModelId,
  };
}

async function loadCoverageState(
  eligiblePrompts: EligiblePrompt[],
  models: EligibleModel[],
): Promise<CoverageState> {
  if (eligiblePrompts.length === 0 || models.length === 0) {
    return {
      modelPromptDecisiveVotes: new Map(),
      pairDecisiveVotes: new Map(),
      pairPromptCounts: new Map(),
      pairPromptDecisiveVotes: new Map(),
      promptCoverageByModelId: new Map(),
      promptDecisiveTotals: new Map(),
    };
  }

  const eligiblePromptIds = eligiblePrompts.map((prompt) => prompt.id);
  const eligibleModelIds = models.map((model) => model.id);
  const promptIdList = Prisma.join(eligiblePromptIds);
  const modelIdList = Prisma.join(eligibleModelIds);

  const [modelPromptRows, pairRows, pairPromptRows] = await Promise.all([
    prisma.$queryRaw<ModelPromptCoverageRow[]>`
      WITH decisive_votes AS (
        SELECT matchup."modelAId" AS "modelId", matchup."promptId" AS "promptId"
        FROM "Vote" vote
        INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
        WHERE vote.choice IN ('A', 'B')
          AND matchup."promptId" IN (${promptIdList})
          AND matchup."modelAId" IN (${modelIdList})
          AND matchup."modelBId" IN (${modelIdList})

        UNION ALL

        SELECT matchup."modelBId" AS "modelId", matchup."promptId" AS "promptId"
        FROM "Vote" vote
        INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
        WHERE vote.choice IN ('A', 'B')
          AND matchup."promptId" IN (${promptIdList})
          AND matchup."modelAId" IN (${modelIdList})
          AND matchup."modelBId" IN (${modelIdList})
      )
      SELECT
        decisive_votes."modelId" AS "modelId",
        decisive_votes."promptId" AS "promptId",
        COUNT(*)::int AS "decisiveVotes"
      FROM decisive_votes
      GROUP BY decisive_votes."modelId", decisive_votes."promptId"
    `,
    prisma.$queryRaw<PairCoverageRow[]>`
      SELECT
        LEAST(matchup."modelAId", matchup."modelBId") AS "modelLowId",
        GREATEST(matchup."modelAId", matchup."modelBId") AS "modelHighId",
        COUNT(*)::int AS "decisiveVotes",
        COUNT(DISTINCT matchup."promptId")::int AS "promptCount"
      FROM "Vote" vote
      INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
      WHERE vote.choice IN ('A', 'B')
        AND matchup."promptId" IN (${promptIdList})
        AND matchup."modelAId" IN (${modelIdList})
        AND matchup."modelBId" IN (${modelIdList})
      GROUP BY LEAST(matchup."modelAId", matchup."modelBId"), GREATEST(matchup."modelAId", matchup."modelBId")
    `,
    prisma.$queryRaw<PairPromptCoverageRow[]>`
      SELECT
        LEAST(matchup."modelAId", matchup."modelBId") AS "modelLowId",
        GREATEST(matchup."modelAId", matchup."modelBId") AS "modelHighId",
        matchup."promptId" AS "promptId",
        COUNT(*)::int AS "decisiveVotes"
      FROM "Vote" vote
      INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
      WHERE vote.choice IN ('A', 'B')
        AND matchup."promptId" IN (${promptIdList})
        AND matchup."modelAId" IN (${modelIdList})
        AND matchup."modelBId" IN (${modelIdList})
      GROUP BY LEAST(matchup."modelAId", matchup."modelBId"), GREATEST(matchup."modelAId", matchup."modelBId"), matchup."promptId"
    `,
  ]);

  const modelPromptDecisiveVotes = new Map<string, number>();
  const pairDecisiveVotes = new Map<string, number>();
  const pairPromptCounts = new Map<string, number>();
  const pairPromptDecisiveVotes = new Map<string, number>();
  const promptDecisiveTotals = new Map<string, number>();

  for (const row of modelPromptRows) {
    const decisiveVotes = toNumber(row.decisiveVotes);
    modelPromptDecisiveVotes.set(modelPromptKey(row.modelId, row.promptId), decisiveVotes);
    promptDecisiveTotals.set(
      row.promptId,
      (promptDecisiveTotals.get(row.promptId) ?? 0) + decisiveVotes,
    );
  }

  for (const row of pairRows) {
    const key = pairKey(row.modelLowId, row.modelHighId);
    pairDecisiveVotes.set(key, toNumber(row.decisiveVotes));
    pairPromptCounts.set(key, toNumber(row.promptCount));
  }

  for (const row of pairPromptRows) {
    pairPromptDecisiveVotes.set(
      pairPromptKey(row.modelLowId, row.modelHighId, row.promptId),
      toNumber(row.decisiveVotes),
    );
  }

  const totalPrompts = eligiblePrompts.length;
  const promptCoverageByModelId = new Map<string, number>();
  for (const model of models) {
    let covered = 0;
    for (const prompt of eligiblePrompts) {
      const votes = modelPromptDecisiveVotes.get(modelPromptKey(model.id, prompt.id)) ?? 0;
      if (votes >= PROMPT_COVERAGE_FLOOR) covered += 1;
    }
    promptCoverageByModelId.set(model.id, totalPrompts > 0 ? covered / totalPrompts : 0);
  }

  return {
    modelPromptDecisiveVotes,
    pairDecisiveVotes,
    pairPromptCounts,
    pairPromptDecisiveVotes,
    promptCoverageByModelId,
    promptDecisiveTotals,
  };
}

function getCommonPromptIds(
  promptIdsByModelId: Map<string, Set<string>>,
  modelAId: string,
  modelBId: string,
  forcedPromptId?: string,
): string[] {
  if (forcedPromptId) {
    const hasA = promptIdsByModelId.get(modelAId)?.has(forcedPromptId) ?? false;
    const hasB = promptIdsByModelId.get(modelBId)?.has(forcedPromptId) ?? false;
    return hasA && hasB ? [forcedPromptId] : [];
  }

  const setA = promptIdsByModelId.get(modelAId);
  const setB = promptIdsByModelId.get(modelBId);
  if (!setA || !setB) return [];

  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  const result: string[] = [];
  for (const promptId of smaller) {
    if (larger.has(promptId)) result.push(promptId);
  }
  return result;
}

function choosePromptForPair(params: {
  promptById: Map<string, EligiblePrompt>;
  commonPromptIds: string[];
  coverage: CoverageState;
  modelAId: string;
  modelBId: string;
  lane: Lane;
}): EligiblePrompt | null {
  const { promptById, commonPromptIds, coverage, modelAId, modelBId, lane } = params;
  if (commonPromptIds.length === 0) return null;

  const scored = commonPromptIds
    .map((promptId) => {
      const prompt = promptById.get(promptId);
      if (!prompt) return null;

      const votesA = getModelPromptVotes(coverage, modelAId, promptId);
      const votesB = getModelPromptVotes(coverage, modelBId, promptId);
      const pairPromptVotes = getPairPromptVotes(coverage, modelAId, modelBId, promptId);

      let score = pairPromptVotes * 4 + votesA + votesB;
      if (lane === "coverage") {
        score = votesA + votesB + pairPromptVotes * 6;
      } else if (lane === "contender") {
        score = pairPromptVotes * 10 + Math.abs(votesA - votesB) * 0.25;
      } else if (lane === "uncertainty") {
        score = pairPromptVotes * 3 + Math.abs(votesA - votesB) + (votesA + votesB) / 2;
      } else if (lane === "exploration") {
        score = pairPromptVotes * 2 + (votesA + votesB) / 2;
      }

      return { prompt, score };
    })
    .filter((entry): entry is { prompt: EligiblePrompt; score: number } => entry != null)
    .sort((a, b) => a.score - b.score);

  return scored[0]?.prompt ?? null;
}

function chooseCoverageMatchup(params: {
  models: EligibleModel[];
  promptById: Map<string, EligiblePrompt>;
  promptIdsByModelId: Map<string, Set<string>>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const { models, promptById, promptIdsByModelId, coverage, forcedPromptId } = params;
  if (models.length < 2) return null;

  const anchorCandidates = [...models].sort((a, b) => {
    const coverageA = coverage.promptCoverageByModelId.get(a.id) ?? 0;
    const coverageB = coverage.promptCoverageByModelId.get(b.id) ?? 0;
    if (coverageA !== coverageB) return coverageA - coverageB;
    if (a.shownCount !== b.shownCount) return a.shownCount - b.shownCount;
    return a.displayName.localeCompare(b.displayName);
  });

  const anchor = anchorCandidates[0];
  if (!anchor) return null;

  const opponents = models
    .filter((model) => model.id !== anchor.id)
    .map((candidate) => {
      const commonPromptIds = getCommonPromptIds(
        promptIdsByModelId,
        anchor.id,
        candidate.id,
        forcedPromptId,
      );
      if (commonPromptIds.length === 0) return null;
      const pairVotes = getPairVotes(coverage, anchor.id, candidate.id);
      const coverageGap = Math.abs(
        (coverage.promptCoverageByModelId.get(anchor.id) ?? 0) -
          (coverage.promptCoverageByModelId.get(candidate.id) ?? 0),
      );
      return {
        candidate,
        pairVotes,
        coverageGap,
        commonPromptIds,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        candidate: EligibleModel;
        pairVotes: number;
        coverageGap: number;
        commonPromptIds: string[];
      } => entry != null,
    )
    .sort((a, b) => a.pairVotes - b.pairVotes || a.coverageGap - b.coverageGap);

  const opponent = opponents[0];
  if (!opponent) return null;

  const prompt = choosePromptForPair({
    promptById,
    commonPromptIds: opponent.commonPromptIds,
    coverage,
    modelAId: anchor.id,
    modelBId: opponent.candidate.id,
    lane: "coverage",
  });
  if (!prompt) return null;

  return {
    lane: "coverage",
    reason: `anchor:${anchor.key}`,
    prompt,
    modelA: anchor,
    modelB: opponent.candidate,
  };
}

function chooseContenderMatchup(params: {
  models: EligibleModel[];
  promptById: Map<string, EligiblePrompt>;
  promptIdsByModelId: Map<string, Set<string>>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const { models, promptById, promptIdsByModelId, coverage, forcedPromptId } = params;
  if (models.length < 2) return null;

  const ranked = [...models].sort((a, b) => b.conservativeRating - a.conservativeRating);
  const contenders = ranked.slice(0, CONTENDER_BAND_SIZE);
  const challengers = ranked.slice(CONTENDER_BAND_SIZE, CONTENDER_BAND_SIZE + 8);
  if (contenders.length < 2) return null;

  const adjacentDeficits = contenders
    .slice(0, Math.max(0, contenders.length - 1))
    .map((left, index) => {
      const right = contenders[index + 1];
      if (!right) return null;
      const pairVotes = getPairVotes(coverage, left.id, right.id);
      const pairPrompts = getPairPromptCount(coverage, left.id, right.id);
      const voteDeficit = Math.max(0, ADJ_PAIR_VOTES_FLOOR - pairVotes);
      const promptDeficit = Math.max(0, ADJ_PAIR_PROMPTS_FLOOR - pairPrompts);
      if (voteDeficit <= 0 && promptDeficit <= 0) return null;
      return {
        left,
        right,
        pairVotes,
        pairPrompts,
        voteDeficit,
        promptDeficit,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        left: EligibleModel;
        right: EligibleModel;
        pairVotes: number;
        pairPrompts: number;
        voteDeficit: number;
        promptDeficit: number;
      } => entry != null,
    )
    .sort(
      (a, b) =>
        b.promptDeficit - a.promptDeficit ||
        b.voteDeficit - a.voteDeficit ||
        a.pairPrompts - b.pairPrompts ||
        a.pairVotes - b.pairVotes,
    );

  const targetAdjacentPair = adjacentDeficits[0] ?? null;
  if (targetAdjacentPair) {
    const swap = Math.random() < 0.5;
    const anchor = swap ? targetAdjacentPair.right : targetAdjacentPair.left;
    const opponent = swap ? targetAdjacentPair.left : targetAdjacentPair.right;
    const commonPromptIds = getCommonPromptIds(
      promptIdsByModelId,
      anchor.id,
      opponent.id,
      forcedPromptId,
    );
    if (commonPromptIds.length > 0) {
      const prompt = choosePromptForPair({
        promptById,
        commonPromptIds,
        coverage,
        modelAId: anchor.id,
        modelBId: opponent.id,
        lane: "contender",
      });
      if (prompt) {
        return {
          lane: "contender",
          reason: `adjacent-floor:${anchor.key}|${opponent.key}`,
          prompt,
          modelA: anchor,
          modelB: opponent,
        };
      }
    }
  }

  const anchor = randomPick(contenders);
  if (!anchor) return null;

  const anchorIndex = contenders.findIndex((model) => model.id === anchor.id);
  const nearestCandidates = [
    contenders[anchorIndex - 1],
    contenders[anchorIndex + 1],
  ].filter((model): model is EligibleModel => model != null);

  const byRatingDistance = (pool: EligibleModel[]) =>
    [...pool]
      .filter((model) => model.id !== anchor.id)
      .sort(
        (a, b) =>
          Math.abs(a.conservativeRating - anchor.conservativeRating) -
          Math.abs(b.conservativeRating - anchor.conservativeRating),
      );

  const contenderCandidates = byRatingDistance(contenders);
  const challengerCandidates = byRatingDistance(challengers);

  const sample = Math.random();
  const buckets: EligibleModel[][] =
    sample < 0.7
      ? [nearestCandidates, contenderCandidates, challengerCandidates]
      : sample < 0.9
        ? [contenderCandidates, nearestCandidates, challengerCandidates]
        : [challengerCandidates, nearestCandidates, contenderCandidates];

  let opponent: EligibleModel | null = null;
  let commonPromptIds: string[] = [];

  for (const bucket of buckets) {
    for (const candidate of bucket) {
      if (!candidate || candidate.id === anchor.id) continue;
      const prompts = getCommonPromptIds(promptIdsByModelId, anchor.id, candidate.id, forcedPromptId);
      if (prompts.length === 0) continue;
      opponent = candidate;
      commonPromptIds = prompts;
      break;
    }
    if (opponent) break;
  }

  if (!opponent || commonPromptIds.length === 0) return null;

  const prompt = choosePromptForPair({
    promptById,
    commonPromptIds,
    coverage,
    modelAId: anchor.id,
    modelBId: opponent.id,
    lane: "contender",
  });
  if (!prompt) return null;

  return {
    lane: "contender",
    reason: `anchor:${anchor.key}`,
    prompt,
    modelA: anchor,
    modelB: opponent,
  };
}

function chooseUncertaintyMatchup(params: {
  models: EligibleModel[];
  promptById: Map<string, EligiblePrompt>;
  promptIdsByModelId: Map<string, Set<string>>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const { models, promptById, promptIdsByModelId, coverage, forcedPromptId } = params;
  if (models.length < 2) return null;

  const anchor = weightedPick(models, (model) => {
    const promptCoverage = coverage.promptCoverageByModelId.get(model.id) ?? 0;
    return model.ratingDeviation * (1 + (1 - promptCoverage));
  });

  if (!anchor) return null;

  const candidates = models
    .filter((model) => model.id !== anchor.id)
    .map((candidate) => {
      const commonPromptIds = getCommonPromptIds(
        promptIdsByModelId,
        anchor.id,
        candidate.id,
        forcedPromptId,
      );
      if (commonPromptIds.length === 0) return null;

      const prediction = expectedScore(anchor.conservativeRating, candidate.conservativeRating);
      const infoGain = 1 - Math.abs(prediction - 0.5) * 2;
      const pairVotes = getPairVotes(coverage, anchor.id, candidate.id);
      const coverageBonus = 1 / (pairVotes + 1);

      return {
        candidate,
        commonPromptIds,
        score: infoGain + coverageBonus * 0.25,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        candidate: EligibleModel;
        commonPromptIds: string[];
        score: number;
      } => entry != null,
    )
    .sort((a, b) => b.score - a.score);

  const opponent = candidates[0];
  if (!opponent) return null;

  const prompt = choosePromptForPair({
    promptById,
    commonPromptIds: opponent.commonPromptIds,
    coverage,
    modelAId: anchor.id,
    modelBId: opponent.candidate.id,
    lane: "uncertainty",
  });
  if (!prompt) return null;

  return {
    lane: "uncertainty",
    reason: `anchor:${anchor.key}`,
    prompt,
    modelA: anchor,
    modelB: opponent.candidate,
  };
}

function chooseExplorationMatchup(params: {
  prompts: EligiblePrompt[];
  modelsById: Map<string, EligibleModel>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const { prompts, modelsById, coverage, forcedPromptId } = params;
  if (prompts.length === 0) return null;

  const promptPool = forcedPromptId
    ? prompts.filter((prompt) => prompt.id === forcedPromptId)
    : prompts;
  if (promptPool.length === 0) return null;

  const prompt = weightedPick(promptPool, (candidate) => {
    const decisive = coverage.promptDecisiveTotals.get(candidate.id) ?? 0;
    return 1 / (decisive + 1);
  });
  if (!prompt) return null;

  const promptModels = prompt.modelIds
    .map((modelId) => modelsById.get(modelId) ?? null)
    .filter((model): model is EligibleModel => model != null);
  if (promptModels.length < 2) return null;

  const modelA = weightedPick(promptModels, (model) => 1 / (model.shownCount + 1));
  if (!modelA) return null;
  const remaining = promptModels.filter((model) => model.id !== modelA.id);
  const modelB = weightedPick(remaining, (model) => 1 / (model.shownCount + 1));
  if (!modelB) return null;

  return {
    lane: "exploration",
    reason: `prompt:${prompt.id}`,
    prompt,
    modelA,
    modelB,
  };
}

function pickMatchup(params: {
  prompts: EligiblePrompt[];
  modelsById: Map<string, EligibleModel>;
  promptIdsByModelId: Map<string, Set<string>>;
  coverage: CoverageState;
  forcedPromptId?: string;
}): MatchupChoice | null {
  const models = Array.from(params.modelsById.values());
  if (models.length < 2) return null;

  const promptById = new Map(params.prompts.map((prompt) => [prompt.id, prompt]));
  const primaryLane = chooseLane();

  for (const lane of candidateLanes(primaryLane)) {
    const input = {
      models,
      promptById,
      promptIdsByModelId: params.promptIdsByModelId,
      coverage: params.coverage,
      forcedPromptId: params.forcedPromptId,
    };

    const choice =
      lane === "coverage"
        ? chooseCoverageMatchup(input)
        : lane === "contender"
          ? chooseContenderMatchup(input)
          : lane === "uncertainty"
            ? chooseUncertaintyMatchup(input)
            : chooseExplorationMatchup({
                prompts: params.prompts,
                modelsById: params.modelsById,
                coverage: params.coverage,
                forcedPromptId: params.forcedPromptId,
              });

    if (choice) return choice;
  }

  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedPromptId = url.searchParams.get("promptId") ?? undefined;

  const { prompts, modelsById, promptIdsByModelId } = await getEligiblePromptsAndModels();
  if (prompts.length === 0) {
    return NextResponse.json(
      { error: "No seeded prompts found. Seed curated prompts/builds first." },
      { status: 409 },
    );
  }

  const forcedPromptId = prompts.some((prompt) => prompt.id === requestedPromptId)
    ? requestedPromptId
    : undefined;

  const coverage = await loadCoverageState(prompts, Array.from(modelsById.values()));
  const picked = pickMatchup({
    prompts,
    modelsById,
    promptIdsByModelId,
    coverage,
    forcedPromptId,
  });

  if (!picked) {
    return NextResponse.json(
      { error: "Failed to sample matchup models" },
      { status: 500 },
    );
  }

  const swapSides = Math.random() < 0.5;
  const leftModel = swapSides ? picked.modelB : picked.modelA;
  const rightModel = swapSides ? picked.modelA : picked.modelB;
  const startedAt = performance.now();

  const [buildA, buildB] = await Promise.all([
    prisma.build.findFirst({
      where: {
        promptId: picked.prompt.id,
        modelId: leftModel.id,
        gridSize: ARENA_GRID_SIZE,
        palette: ARENA_PALETTE,
        mode: ARENA_MODE,
      },
      select: {
        id: true,
        gridSize: true,
        palette: true,
        blockCount: true,
        voxelByteSize: true,
        voxelCompressedByteSize: true,
        voxelSha256: true,
        voxelData: true,
        voxelStorageBucket: true,
        voxelStoragePath: true,
        voxelStorageEncoding: true,
      },
    }),
    prisma.build.findFirst({
      where: {
        promptId: picked.prompt.id,
        modelId: rightModel.id,
        gridSize: ARENA_GRID_SIZE,
        palette: ARENA_PALETTE,
        mode: ARENA_MODE,
      },
      select: {
        id: true,
        gridSize: true,
        palette: true,
        blockCount: true,
        voxelByteSize: true,
        voxelCompressedByteSize: true,
        voxelSha256: true,
        voxelData: true,
        voxelStorageBucket: true,
        voxelStoragePath: true,
        voxelStorageEncoding: true,
      },
    }),
  ]);

  if (!buildA || !buildB) {
    return NextResponse.json({ error: "Missing seeded build" }, { status: 500 });
  }

  let preparedA: Awaited<ReturnType<typeof prepareArenaBuild>>;
  let preparedB: Awaited<ReturnType<typeof prepareArenaBuild>>;
  try {
    [preparedA, preparedB] = await Promise.all([prepareArenaBuild(buildA), prepareArenaBuild(buildB)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load build payload";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const created = await prisma.$transaction(async (tx) => {
    const matchup = await tx.matchup.create({
      data: {
        promptId: picked.prompt.id,
        modelAId: leftModel.id,
        modelBId: rightModel.id,
        buildAId: buildA.id,
        buildBId: buildB.id,
        samplingLane: picked.lane,
        samplingReason: picked.reason,
      },
    });

    await Promise.all([
      tx.model.update({
        where: { id: leftModel.id },
        data: { shownCount: { increment: 1 } },
      }),
      tx.model.update({
        where: { id: rightModel.id },
        data: { shownCount: { increment: 1 } },
      }),
    ]);

    return matchup;
  });

  const body: ArenaMatchup = {
    id: created.id,
    samplingLane: picked.lane,
    prompt: { id: picked.prompt.id, text: picked.prompt.text },
    a: {
      model: {
        key: leftModel.key,
        provider: leftModel.provider,
        displayName: leftModel.displayName,
        eloRating: leftModel.eloRating,
      },
      build: pickInitialBuild(preparedA) as ArenaMatchup["a"]["build"],
      buildRef: preparedA.buildRef,
      previewRef: preparedA.previewRef,
      serverValidated: true,
      buildLoadHints: preparedA.hints,
    },
    b: {
      model: {
        key: rightModel.key,
        provider: rightModel.provider,
        displayName: rightModel.displayName,
        eloRating: rightModel.eloRating,
      },
      build: pickInitialBuild(preparedB) as ArenaMatchup["b"]["build"],
      buildRef: preparedB.buildRef,
      previewRef: preparedB.previewRef,
      serverValidated: true,
      buildLoadHints: preparedB.hints,
    },
  };

  const prepareMs = Math.round(performance.now() - startedAt);
  const res = NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store",
      "x-build-prepare-ms": String(prepareMs),
      "x-build-initial-a": preparedA.hints.initialVariant,
      "x-build-initial-b": preparedB.hints.initialVariant,
    },
  });
  getOrSetSessionId(res, req);
  return res;
}
