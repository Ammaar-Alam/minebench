import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { summarizeArenaVotes } from "@/lib/arena/voteMath";
import { confidenceFromRd, conservativeScore, stabilityTier } from "@/lib/arena/rating";
import {
  ARENA_BUILD_GRID_SIZE,
  ARENA_BUILD_MODE,
  ARENA_BUILD_PALETTE,
  getArenaEligiblePromptIds,
} from "@/lib/arena/eligibility";

const MIN_PROMPTS_FOR_SPREAD = 3;
const MIN_PROMPTS_FOR_CONSISTENCY = 5;
const PROMPT_COVERAGE_FLOOR = 2;
const CONSISTENCY_TAIL_SHARE = 0.2;
const CONSISTENCY_QUADRATIC_WEIGHT = 0.75;
const RECENT_FORM_WINDOW = 30;
// process-local caches; longer TTLs reduce cold-lambda BT recompute cost.
// vote drains call invalidateArenaStatsCache so stale data is bounded by writes.
const LEADERBOARD_CACHE_TTL_MS = 120_000;
const MODEL_DETAIL_CACHE_TTL_MS = 120_000;
const PROMPT_SIGNAL_CACHE_TTL_MS = 120_000;
// 600 iters converges for our model count; 2000 was a safety margin from earlier tuning
const BT_MAX_ITERS = 600;
const BT_CONVERGENCE_EPSILON = 1e-9;
const BT_PSEUDOINVERSE_RIDGE = 1e-9;
const BT_VARIANCE_FLOOR = 1e-6;

type NumberLike = number | bigint | string | null;

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

type PromptScoreSample = {
  promptId: string;
  averageScore: number;
  votes: number;
  promptStrengthPercentile: number | null;
};

type PairwiseRow = {
  modelAId: string;
  modelBId: string;
  pointsA: number;
  pointsB: number;
  total: number;
};

type PromptDispersionRow = {
  modelId: string;
  promptId: string;
  promptAverage: NumberLike;
  promptVotes: NumberLike;
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

type PromptSignalPairAggregateRow = {
  promptId: string;
  modelAId: string;
  modelBId: string;
  pointsA: NumberLike;
  pointsB: NumberLike;
  total: NumberLike;
};

type PromptStrengthStats = {
  rank: number;
  total: number;
  percentile: number;
  theta: number;
  rawRank: number;
  rawPercentile: number;
  rawTheta: number;
  variance: number | null;
  shrinkage: number | null;
};

type PromptSignalSnapshot = {
  eligiblePromptIds: string[];
  activeModelIds: string[];
  byPromptModel: Map<string, PromptStrengthStats>;
};

type RankedPromptStrengthRow = PromptStrengthStats & {
  id: string;
  displayName: string;
};

let leaderboardCache: CachedValue<Map<string, ScoreDispersion>> | null = null;
let leaderboardInFlight: Promise<Map<string, ScoreDispersion>> | null = null;
const modelDetailCache = new Map<string, CachedValue<ModelDetailStats | null>>();
const modelDetailInFlight = new Map<string, Promise<ModelDetailStats | null>>();
let promptSignalCache: CachedValue<PromptSignalSnapshot> | null = null;
let promptSignalInFlight: Promise<PromptSignalSnapshot> | null = null;

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
  promptStrengthPercentile: number | null;
  promptStrengthRank: number | null;
  promptStrengthTotal: number | null;
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

function variance(values: number[]): number | null {
  const mean = average(values);
  if (mean == null) return null;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function normalizeGridSize(value: number): 64 | 256 | 512 {
  if (value === 64 || value === 256 || value === 512) return value;
  return ARENA_BUILD_GRID_SIZE;
}

function normalizePalette(value: string): "simple" | "advanced" {
  return value === "advanced" ? "advanced" : "simple";
}

function roundMetric(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

function clampMetric(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function promptModelKey(promptId: string, modelId: string): string {
  return `${promptId}|${modelId}`;
}

function pairKey(modelAId: string, modelBId: string): string {
  return modelAId < modelBId ? `${modelAId}|${modelBId}` : `${modelBId}|${modelAId}`;
}

function percentileFromRank(rank: number, total: number): number {
  if (total <= 1) return 100;
  return ((total - rank) / (total - 1)) * 100;
}

function promptStrengthConsistency(values: number[]): number | null {
  if (values.length < MIN_PROMPTS_FOR_CONSISTENCY) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const tailCount = Math.max(1, Math.ceil(CONSISTENCY_TAIL_SHARE * sorted.length));
  const lowTail = average(sorted.slice(0, tailCount));
  const highTail = average(sorted.slice(-tailCount));
  if (lowTail == null || highTail == null) return null;
  const gap = highTail - lowTail;
  const score = 100 - gap - (CONSISTENCY_QUADRATIC_WEIGHT * gap * gap) / 100;
  return roundMetric(clampMetric(score, 0, 100));
}

function invertMatrix(matrix: number[][]): number[][] | null {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => [
    ...row.map((value) => value),
    ...Array.from({ length: size }, (_, colIndex) => (rowIndex === colIndex ? 1 : 0)),
  ]);

  for (let col = 0; col < size; col += 1) {
    let pivotRow = col;
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivotRow][col])) {
        pivotRow = row;
      }
    }

    const pivot = augmented[pivotRow]?.[col] ?? 0;
    if (Math.abs(pivot) < BT_PSEUDOINVERSE_RIDGE) return null;

    if (pivotRow !== col) {
      [augmented[col], augmented[pivotRow]] = [augmented[pivotRow], augmented[col]];
    }

    for (let c = 0; c < size * 2; c += 1) {
      augmented[col][c] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];
      if (factor === 0) continue;
      for (let c = 0; c < size * 2; c += 1) {
        augmented[row][c] -= factor * augmented[col][c];
      }
    }
  }

  return augmented.map((row) => row.slice(size));
}

function buildConnectedComponents(
  modelIds: Iterable<string>,
  pairRows: PairwiseRow[],
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const modelId of modelIds) {
    adjacency.set(modelId, new Set());
  }
  for (const row of pairRows) {
    adjacency.get(row.modelAId)?.add(row.modelBId);
    adjacency.get(row.modelBId)?.add(row.modelAId);
  }

  const components: string[][] = [];
  const seen = new Set<string>();

  for (const modelId of adjacency.keys()) {
    if (seen.has(modelId)) continue;
    const stack = [modelId];
    const component: string[] = [];
    seen.add(modelId);

    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        stack.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

function varianceFallbackFromTotals(totals: number[][], pi: number[]): number[] {
  return totals.map((row, index) => {
    let information = 0;
    for (let neighbor = 0; neighbor < row.length; neighbor += 1) {
      if (neighbor === index || row[neighbor] === 0) continue;
      const prob = pi[index] / (pi[index] + pi[neighbor]);
      information += row[neighbor] * prob * (1 - prob);
    }
    return information > 0 ? 1 / information : 1;
  });
}

function computeBradleyTerryVariances(totals: number[][], pi: number[]): number[] {
  const size = totals.length;
  if (size <= 1) return [1];

  const laplacian = Array.from({ length: size }, () => Array(size).fill(0));
  for (let i = 0; i < size; i += 1) {
    for (let j = i + 1; j < size; j += 1) {
      const total = totals[i][j];
      if (total === 0) continue;
      const prob = pi[i] / (pi[i] + pi[j]);
      const weight = total * prob * (1 - prob);
      laplacian[i][i] += weight;
      laplacian[j][j] += weight;
      laplacian[i][j] -= weight;
      laplacian[j][i] -= weight;
    }
  }

  const allOnesShare = 1 / size;
  const stabilized = laplacian.map((row, rowIndex) =>
    row.map((value, colIndex) => {
      const ridge = rowIndex === colIndex ? BT_PSEUDOINVERSE_RIDGE : 0;
      return value + allOnesShare + ridge;
    }),
  );
  const inverted = invertMatrix(stabilized);
  if (!inverted) {
    return varianceFallbackFromTotals(totals, pi).map((value) =>
      Math.max(BT_VARIANCE_FLOOR, value),
    );
  }

  return inverted.map((row, index) =>
    Math.max(BT_VARIANCE_FLOOR, row[index] - allOnesShare),
  );
}

function aggregatePairRow(
  pairRows: Map<string, PairwiseRow>,
  modelAId: string,
  modelBId: string,
  pointsA: number,
  pointsB: number,
  total = 1,
) {
  if (modelAId === modelBId) return;
  const canonicalA = modelAId < modelBId ? modelAId : modelBId;
  const canonicalB = canonicalA === modelAId ? modelBId : modelAId;
  const canonicalPointsA = canonicalA === modelAId ? pointsA : pointsB;
  const canonicalPointsB = canonicalA === modelAId ? pointsB : pointsA;
  const key = pairKey(canonicalA, canonicalB);
  const row = pairRows.get(key) ?? {
    modelAId: canonicalA,
    modelBId: canonicalB,
    pointsA: 0,
    pointsB: 0,
    total: 0,
  };
  row.pointsA += canonicalPointsA;
  row.pointsB += canonicalPointsB;
  row.total += total;
  pairRows.set(key, row);
}

type BradleyTerryFitRow = {
  id: string;
  theta: number;
  rawTheta: number;
  strength: number;
  variance: number;
  displayName: string;
};

function fitBradleyTerryConnectedComponent(
  modelIds: string[],
  pairRows: PairwiseRow[],
  displayNames: Map<string, string>,
): BradleyTerryFitRow[] {
  const ids = [...modelIds];
  if (ids.length === 1) {
    return [
      {
        id: ids[0],
        theta: 0,
        rawTheta: 0,
        strength: 1,
        variance: 1,
        displayName: displayNames.get(ids[0]) ?? ids[0],
      },
    ];
  }

  const indexById = new Map(ids.map((id, idx) => [id, idx]));
  const n = ids.length;
  const points = Array.from({ length: n }, () => Array(n).fill(0));
  const totals = Array.from({ length: n }, () => Array(n).fill(0));

  for (const row of pairRows) {
    const i = indexById.get(row.modelAId);
    const j = indexById.get(row.modelBId);
    if (i == null || j == null) continue;
    points[i][j] += row.pointsA;
    points[j][i] += row.pointsB;
    totals[i][j] += row.total;
    totals[j][i] += row.total;
  }

  let pi = Array(n).fill(1);

  for (let iter = 0; iter < BT_MAX_ITERS; iter += 1) {
    const next = Array(n).fill(0);
    let maxDelta = 0;

    for (let i = 0; i < n; i += 1) {
      let wins = 0;
      let denom = 0;
      for (let j = 0; j < n; j += 1) {
        if (i === j || totals[i][j] === 0) continue;
        wins += points[i][j];
        denom += totals[i][j] / (pi[i] + pi[j]);
      }
      next[i] = denom > 0 ? wins / denom : 0;
    }

    const mean = next.reduce((sum, value) => sum + value, 0) / n || 1;
    for (let i = 0; i < n; i += 1) {
      next[i] = next[i] / mean;
      maxDelta = Math.max(maxDelta, Math.abs(next[i] - pi[i]));
    }

    pi = next;
    if (maxDelta < BT_CONVERGENCE_EPSILON) break;
  }

  const rawThetas = pi.map((strength) => Math.log(Math.max(strength, 1e-12)));
  const thetaCenter = average(rawThetas) ?? 0;
  const variances = computeBradleyTerryVariances(totals, pi);

  return ids
    .map((id, idx) => {
      const strength = Math.max(pi[idx], 1e-12);
      return {
        id,
        strength,
        rawTheta: rawThetas[idx],
        theta: rawThetas[idx] - thetaCenter,
        variance: variances[idx] ?? 1,
        displayName: displayNames.get(id) ?? id,
      };
    });
}

function fitBradleyTerry(
  modelIds: Iterable<string>,
  pairRows: PairwiseRow[],
  displayNames: Map<string, string>,
  alphaByModelId?: Map<string, number>,
): BradleyTerryFitRow[] {
  const ids = [...modelIds];
  const components = buildConnectedComponents(ids, pairRows);
  const rows: BradleyTerryFitRow[] = [];

  for (const componentIds of components) {
    const componentIdSet = new Set(componentIds);
    const componentRows = pairRows.filter(
      (row) => componentIdSet.has(row.modelAId) && componentIdSet.has(row.modelBId),
    );
    const fittedRows = fitBradleyTerryConnectedComponent(componentIds, componentRows, displayNames);

    if (alphaByModelId) {
      const offset =
        average(
          fittedRows.map((row) => row.theta - (alphaByModelId.get(row.id) ?? 0)),
        ) ?? 0;
      for (const row of fittedRows) {
        row.theta -= offset;
      }
    }

    rows.push(...fittedRows);
  }

  return rows.sort((a, b) => b.theta - a.theta || a.displayName.localeCompare(b.displayName));
}

function shrinkPromptStrengthRows(
  rows: BradleyTerryFitRow[],
  displayNames: Map<string, string>,
  alphaByModelId: Map<string, number>,
): RankedPromptStrengthRow[] {
  if (rows.length === 0) return [];

  const rawSorted = [...rows].sort((a, b) => b.theta - a.theta || a.displayName.localeCompare(b.displayName));
  const rawRankById = new Map(
    rawSorted.map((row, index) => [
      row.id,
      {
        rank: index + 1,
        percentile: percentileFromRank(index + 1, rawSorted.length),
      },
    ]),
  );

  const deltas = rows.map((row) => row.theta - (alphaByModelId.get(row.id) ?? 0));
  const observedVariance = variance(deltas) ?? 0;
  const meanPosteriorVariance =
    average(
      rows
        .map((row) => row.variance)
        .filter((value) => Number.isFinite(value) && value > 0),
    ) ?? 0;
  const tauSquared = Math.max(0, observedVariance - meanPosteriorVariance);

  const shrunkRows = rows.map((row) => {
    const alpha = alphaByModelId.get(row.id) ?? 0;
    const posteriorVariance = Number.isFinite(row.variance)
      ? Math.max(BT_VARIANCE_FLOOR, row.variance)
      : Number.POSITIVE_INFINITY;
    const shrinkage =
      tauSquared > 0 && Number.isFinite(posteriorVariance)
        ? tauSquared / (tauSquared + posteriorVariance)
        : 0;

    return {
      ...row,
      theta: alpha + shrinkage * (row.theta - alpha),
      strength: Math.exp(alpha + shrinkage * (row.theta - alpha)),
      shrinkage,
    };
  });

  const sorted = [...shrunkRows].sort((a, b) => {
    if (b.theta !== a.theta) return b.theta - a.theta;
    const aName = displayNames.get(a.id) ?? a.id;
    const bName = displayNames.get(b.id) ?? b.id;
    return aName.localeCompare(bName);
  });

  return sorted.map((row, index) => {
    const rawRank = rawRankById.get(row.id);
    const rank = index + 1;
    return {
      id: row.id,
      displayName: row.displayName,
      rank,
      total: sorted.length,
      percentile: percentileFromRank(rank, sorted.length),
      theta: row.theta,
      rawRank: rawRank?.rank ?? rank,
      rawPercentile: rawRank?.percentile ?? percentileFromRank(rank, sorted.length),
      rawTheta: row.rawTheta,
      variance: row.variance,
      shrinkage: row.shrinkage,
    };
  });
}

function summarizeDispersion(samples: PromptScoreSample[], activePromptCount: number): ScoreDispersion {
  const promptAverages: number[] = [];
  const promptStrengthPercentiles: number[] = [];
  let sampledVotes = 0;

  for (const sample of samples) {
    if (sample.votes < PROMPT_COVERAGE_FLOOR) continue;
    promptAverages.push(sample.averageScore);
    sampledVotes += sample.votes;
    if (sample.promptStrengthPercentile != null) {
      promptStrengthPercentiles.push(sample.promptStrengthPercentile);
    }
  }

  const sampledPrompts = promptAverages.length;
  const coveredPrompts = sampledPrompts;
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
  const consistency = promptStrengthConsistency(promptStrengthPercentiles);

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
  promptSignalCache = null;
  modelDetailCache.clear();
}

function promptFilterSql(promptIds: string[]): Prisma.Sql {
  return sqlInColumn(Prisma.sql`matchup."promptId"`, promptIds);
}

function modelFilterSql(column: Prisma.Sql, modelIds: string[]): Prisma.Sql {
  return sqlInColumn(column, modelIds);
}

function sqlInColumn(column: Prisma.Sql, values: string[]): Prisma.Sql {
  if (values.length === 0) {
    return Prisma.sql`FALSE`;
  }
  return Prisma.sql`${column} IN (${Prisma.join(values)})`;
}

async function queryPromptSignalSnapshot(): Promise<PromptSignalSnapshot> {
  const eligiblePromptIds = await getArenaEligiblePromptIds();
  if (eligiblePromptIds.length === 0) {
    return { eligiblePromptIds, activeModelIds: [], byPromptModel: new Map() };
  }

  const models = await prisma.model.findMany({
    where: { enabled: true, isBaseline: false },
    select: { id: true, displayName: true },
  });

  const activeModelIds = models.map((model) => model.id);
  if (activeModelIds.length === 0) {
    return { eligiblePromptIds, activeModelIds, byPromptModel: new Map() };
  }

  const displayNames = new Map(models.map((model) => [model.id, model.displayName]));
  const promptFilter = promptFilterSql(eligiblePromptIds);
  const modelAFilter = modelFilterSql(Prisma.sql`matchup."modelAId"`, activeModelIds);
  const modelBFilter = modelFilterSql(Prisma.sql`matchup."modelBId"`, activeModelIds);
  const pairVotes = await prisma.$queryRaw<PromptSignalPairAggregateRow[]>`
    SELECT
      matchup."promptId" AS "promptId",
      matchup."modelAId" AS "modelAId",
      matchup."modelBId" AS "modelBId",
      SUM(
        CASE vote.choice
          WHEN 'A' THEN 1.0
          WHEN 'B' THEN 0.0
          WHEN 'TIE' THEN 0.5
          ELSE 0.0
        END
      )::double precision AS "pointsA",
      SUM(
        CASE vote.choice
          WHEN 'A' THEN 0.0
          WHEN 'B' THEN 1.0
          WHEN 'TIE' THEN 0.5
          ELSE 0.0
        END
      )::double precision AS "pointsB",
      COUNT(*)::int AS total
    FROM "Vote" vote
    INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
    WHERE vote.choice IN ('A', 'B', 'TIE')
      AND ${promptFilter}
      AND ${modelAFilter}
      AND ${modelBFilter}
    GROUP BY matchup."promptId", matchup."modelAId", matchup."modelBId"
  `;

  const globalPairRows = new Map<string, PairwiseRow>();
  const pairRowsByPrompt = new Map<string, Map<string, PairwiseRow>>();
  const modelIdsByPrompt = new Map<string, Set<string>>();

  for (const row of pairVotes) {
    const promptId = row.promptId;
    const modelAId = row.modelAId;
    const modelBId = row.modelBId;
    const pointsA = toNumber(row.pointsA);
    const pointsB = toNumber(row.pointsB);
    const total = toNumber(row.total);

    aggregatePairRow(globalPairRows, modelAId, modelBId, pointsA, pointsB, total);

    const promptPairs = pairRowsByPrompt.get(promptId) ?? new Map<string, PairwiseRow>();
    aggregatePairRow(promptPairs, modelAId, modelBId, pointsA, pointsB, total);
    pairRowsByPrompt.set(promptId, promptPairs);

    const promptModelIds = modelIdsByPrompt.get(promptId) ?? new Set<string>();
    promptModelIds.add(modelAId);
    promptModelIds.add(modelBId);
    modelIdsByPrompt.set(promptId, promptModelIds);
  }

  const alphaRows = fitBradleyTerry(activeModelIds, [...globalPairRows.values()], displayNames);
  const alphaByModelId = new Map(alphaRows.map((row) => [row.id, row.theta]));
  const byPromptModel = new Map<string, PromptStrengthStats>();

  for (const promptId of eligiblePromptIds) {
    const promptModelIds = modelIdsByPrompt.get(promptId);
    if (!promptModelIds || promptModelIds.size < 2) continue;

    const rows = fitBradleyTerry(
      promptModelIds,
      [...(pairRowsByPrompt.get(promptId)?.values() ?? [])],
      displayNames,
      alphaByModelId,
    );
    const shrunkRows = shrinkPromptStrengthRows(rows, displayNames, alphaByModelId);
    shrunkRows.forEach((row) => {
      byPromptModel.set(promptModelKey(promptId, row.id), {
        rank: row.rank,
        total: row.total,
        percentile: row.percentile,
        theta: row.theta,
        rawRank: row.rawRank,
        rawPercentile: row.rawPercentile,
        rawTheta: row.rawTheta,
        variance: row.variance,
        shrinkage: row.shrinkage,
      });
    });
  }

  return { eligiblePromptIds, activeModelIds, byPromptModel };
}

async function getPromptSignalSnapshot(): Promise<PromptSignalSnapshot> {
  const now = Date.now();
  if (promptSignalCache && promptSignalCache.expiresAt > now) {
    return promptSignalCache.value;
  }
  if (promptSignalInFlight) {
    return promptSignalInFlight;
  }

  promptSignalInFlight = queryPromptSignalSnapshot()
    .then((value) => {
      promptSignalCache = {
        value,
        expiresAt: Date.now() + PROMPT_SIGNAL_CACHE_TTL_MS,
      };
      return value;
    })
    .finally(() => {
      promptSignalInFlight = null;
    });

  return promptSignalInFlight;
}

async function queryLeaderboardDispersionByModelId(): Promise<Map<string, ScoreDispersion>> {
  const promptSignal = await getPromptSignalSnapshot();
  const activePromptCount = promptSignal.eligiblePromptIds.length;
  if (promptSignal.activeModelIds.length === 0) {
    return new Map();
  }
  const filter = promptFilterSql(promptSignal.eligiblePromptIds);
  const activeModelBothFilter = Prisma.sql`
    ${modelFilterSql(Prisma.sql`matchup."modelAId"`, promptSignal.activeModelIds)}
    AND ${modelFilterSql(Prisma.sql`matchup."modelBId"`, promptSignal.activeModelIds)}
  `;
  const rows = await prisma.$queryRaw<PromptDispersionRow[]>`
      WITH eligible_votes AS (
        SELECT
          matchup."promptId" AS prompt_id,
          matchup."modelAId" AS "modelAId",
          matchup."modelBId" AS "modelBId",
          vote.choice AS choice
        FROM "Vote" vote
        INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
        WHERE vote.choice IN ('A', 'B', 'TIE')
          AND ${filter}
          AND ${activeModelBothFilter}
      ),
      model_prompt_scores AS (
        SELECT
          eligible_votes."modelAId" AS model_id,
          eligible_votes.prompt_id AS prompt_id,
          CASE eligible_votes.choice
            WHEN 'A' THEN 1.0
            WHEN 'B' THEN 0.0
            WHEN 'TIE' THEN 0.5
            ELSE NULL
          END AS score
        FROM eligible_votes

        UNION ALL

        SELECT
          eligible_votes."modelBId" AS model_id,
          eligible_votes.prompt_id AS prompt_id,
          CASE eligible_votes.choice
            WHEN 'A' THEN 0.0
            WHEN 'B' THEN 1.0
            WHEN 'TIE' THEN 0.5
            ELSE NULL
          END AS score
        FROM eligible_votes
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
      SELECT per_prompt."modelId", per_prompt."promptId", per_prompt."promptAverage", per_prompt."promptVotes"
      FROM per_prompt
    `;

  const samplesByModelId = new Map<string, PromptScoreSample[]>();
  for (const row of rows) {
    const samples = samplesByModelId.get(row.modelId) ?? [];
    const promptStrength = promptSignal.byPromptModel.get(promptModelKey(row.promptId, row.modelId));
    samples.push({
      promptId: row.promptId,
      averageScore: toNumber(row.promptAverage),
      votes: toNumber(row.promptVotes),
      promptStrengthPercentile: promptStrength?.percentile ?? null,
    });
    samplesByModelId.set(row.modelId, samples);
  }

  const out = new Map<string, ScoreDispersion>();
  for (const [modelId, samples] of samplesByModelId) {
    out.set(modelId, summarizeDispersion(samples, activePromptCount));
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

  const promptSignal = await getPromptSignalSnapshot();
  const activePromptCount = promptSignal.eligiblePromptIds.length;
  const filter = promptFilterSql(promptSignal.eligiblePromptIds);
  const activeOpponentFilter = Prisma.sql`(
    (matchup."modelAId" = ${model.id}
      AND ${modelFilterSql(Prisma.sql`matchup."modelBId"`, promptSignal.activeModelIds)})
    OR
    (matchup."modelBId" = ${model.id}
      AND ${modelFilterSql(Prisma.sql`matchup."modelAId"`, promptSignal.activeModelIds)})
  )`;

  const [promptRows, opponentRows, recentScoreRows, builds] = await Promise.all([
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
      WHERE (matchup."modelAId" = ${model.id} OR matchup."modelBId" = ${model.id})
        AND ${filter}
        AND ${activeOpponentFilter}
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
      WHERE (matchup."modelAId" = ${model.id} OR matchup."modelBId" = ${model.id})
        AND ${filter}
        AND opponent.enabled = true
        AND opponent."isBaseline" = false
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
        AND ${filter}
        AND ${activeOpponentFilter}
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
        promptId: { in: promptSignal.eligiblePromptIds },
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
  ]);

  const promptSamples: PromptScoreSample[] = [];
  const promptStatsById = new Map<
    string,
    {
      promptText: string;
      votes: number;
      averageScore: number;
      promptStrengthPercentile: number | null;
      promptStrengthRank: number | null;
      promptStrengthTotal: number | null;
      wins: number;
      losses: number;
      draws: number;
      bothBad: number;
    }
  >();

  for (const row of promptRows) {
    const votes = toNumber(row.votes);
    const averageScore = toNumber(row.averageScore);
    const promptStrength =
      promptSignal.byPromptModel.get(promptModelKey(row.promptId, model.id)) ?? null;
    promptStatsById.set(row.promptId, {
      promptText: row.promptText,
      votes,
      averageScore,
      promptStrengthPercentile: promptStrength?.percentile ?? null,
      promptStrengthRank: promptStrength?.rank ?? null,
      promptStrengthTotal: promptStrength?.total ?? null,
      wins: toNumber(row.wins),
      losses: toNumber(row.losses),
      draws: toNumber(row.draws),
      bothBad: toNumber(row.bothBad),
    });
    promptSamples.push({
      promptId: row.promptId,
      averageScore,
      votes,
      promptStrengthPercentile: promptStrength?.percentile ?? null,
    });
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
        promptStrengthPercentile: promptStats?.promptStrengthPercentile ?? null,
        promptStrengthRank: promptStats?.promptStrengthRank ?? null,
        promptStrengthTotal: promptStats?.promptStrengthTotal ?? null,
        wins: promptStats?.wins ?? 0,
        losses: promptStats?.losses ?? 0,
        draws: promptStats?.draws ?? 0,
        bothBad: promptStats?.bothBad ?? 0,
        build: buildEntry?.build ?? null,
      };
    })
    .sort(
      (a, b) =>
        (b.promptStrengthPercentile ?? -1) - (a.promptStrengthPercentile ?? -1) ||
        b.votes - a.votes ||
        a.promptText.localeCompare(b.promptText),
    );

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
