import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const MATCHUP_STATE_CACHE_TTL_MS = readIntEnv("ARENA_MATCHUP_STATE_CACHE_TTL_MS", 60_000);
const PENDING_SHOWN_COUNT_TTL_MS = readIntEnv("ARENA_PENDING_SHOWN_COUNT_TTL_MS", 90_000);

const ARENA_GRID_SIZE = 256;
const ARENA_PALETTE = "simple";
const ARENA_MODE = "precise";
const PROMPT_COVERAGE_FLOOR = 2;

type CachedValue<T> = {
  expiresAt: number;
  value: T;
};

export type ArenaMatchupSamplingMeta = {
  cacheStatus: "hit" | "miss" | "inflight";
  eligibilityMs: number;
  coverageMs: number;
  totalMs: number;
};

export type EligiblePrompt = {
  id: string;
  text: string;
  modelIds: string[];
};

export type EligibleModel = {
  id: string;
  key: string;
  provider: string;
  displayName: string;
  eloRating: number;
  conservativeRating: number;
  ratingDeviation: number;
  shownCount: number;
};

export type EligibleBuildMeta = {
  id: string;
  gridSize: number;
  palette: string;
  blockCount: number;
  voxelByteSize: number | null;
  voxelCompressedByteSize: number | null;
  voxelSha256: string | null;
  arenaBuildHints?: unknown | null;
};

export type CoverageState = {
  modelPromptDecisiveVotes: Map<string, number>;
  pairDecisiveVotes: Map<string, number>;
  pairPromptCounts: Map<string, number>;
  pairPromptDecisiveVotes: Map<string, number>;
  promptCoverageByModelId: Map<string, number>;
  promptDecisiveTotals: Map<string, number>;
};

export type ArenaMatchupSamplingState = {
  prompts: EligiblePrompt[];
  modelsById: Map<string, EligibleModel>;
  promptIdsByModelId: Map<string, Set<string>>;
  buildsByModelPromptKey: Map<string, EligibleBuildMeta>;
  coverage: CoverageState;
};

export type ArenaMatchupSamplingResult = {
  state: ArenaMatchupSamplingState;
  meta: ArenaMatchupSamplingMeta;
};

export type PairCoverage = {
  decisiveVotes: number;
  promptCount: number;
};

type NumberLike = number | bigint | string | null;
type SamplingStateMutation = (state: ArenaMatchupSamplingState) => void;

let matchupStateCache: CachedValue<ArenaMatchupSamplingState> | null = null;
let matchupStateInFlight: Promise<ArenaMatchupSamplingResult> | null = null;
let matchupStateVersion = 0;
let coverageSyncInFlight: Promise<void> | null = null;
let pendingSamplingStateMutations: SamplingStateMutation[] = [];
const pendingShownCountDeltas = new Map<string, { count: number; expiresAt: number }>();

const ARENA_COVERAGE_LOCK_KEY = 860101;

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function toNumber(value: NumberLike, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function orderPairIds(modelAId: string, modelBId: string): [string, string] {
  return modelAId < modelBId ? [modelAId, modelBId] : [modelBId, modelAId];
}

export function pairKey(modelAId: string, modelBId: string): string {
  const [low, high] = orderPairIds(modelAId, modelBId);
  return `${low}|${high}`;
}

export function modelPromptKey(modelId: string, promptId: string): string {
  return `${modelId}|${promptId}`;
}

export function pairPromptKey(modelAId: string, modelBId: string, promptId: string): string {
  return `${pairKey(modelAId, modelBId)}|${promptId}`;
}

export function invalidateArenaCoverageCache() {
  matchupStateVersion += 1;
  matchupStateCache = null;
  matchupStateInFlight = null;
  coverageSyncInFlight = null;
  pendingSamplingStateMutations = [];
}

function applySamplingStateMutation(mutation: SamplingStateMutation) {
  const cache = matchupStateCache;
  if (cache && cache.expiresAt > Date.now()) {
    mutation(cache.value);
  }
  if (matchupStateInFlight) {
    pendingSamplingStateMutations.push(mutation);
  }
}

export function recordArenaMatchupShown(modelIds: string[]) {
  const seen = new Set<string>();
  const expiresAt = Date.now() + PENDING_SHOWN_COUNT_TTL_MS;
  for (const modelId of modelIds) {
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const current = pendingShownCountDeltas.get(modelId);
    pendingShownCountDeltas.set(modelId, {
      count: (current?.count ?? 0) + 1,
      expiresAt: Math.max(current?.expiresAt ?? 0, expiresAt),
    });
  }

  applySamplingStateMutation((state) => {
    const cacheSeen = new Set<string>();
    for (const modelId of modelIds) {
      if (!modelId || cacheSeen.has(modelId)) continue;
      cacheSeen.add(modelId);
      const model = state.modelsById.get(modelId);
      if (model) {
        model.shownCount += 1;
      }
    }
  });
}

function shownCountIncrementsForModels(modelIds: string[]): Map<string, number> {
  const increments = new Map<string, number>();
  for (const modelId of modelIds) {
    if (!modelId) continue;
    increments.set(modelId, (increments.get(modelId) ?? 0) + 1);
  }
  return increments;
}

export async function persistArenaMatchupShown(modelIds: string[], client: PrismaClient = prisma) {
  const increments = shownCountIncrementsForModels(modelIds);
  const rows = Array.from(increments.entries());
  if (rows.length === 0) return;

  // impressions persist outside vote jobs
  await client.$executeRaw(Prisma.sql`
    UPDATE "Model" AS model
    SET "shownCount" = model."shownCount" + shown."count"
    FROM (
      VALUES ${Prisma.join(rows.map(([modelId, count]) => Prisma.sql`(${modelId}, ${count})`))}
    ) AS shown("id", "count")
    WHERE model."id" = shown."id"
  `);
  settleArenaMatchupShown(increments);
}

function getPendingShownCountDelta(modelId: string, now = Date.now()): number {
  const pending = pendingShownCountDeltas.get(modelId);
  if (!pending) return 0;
  if (pending.expiresAt <= now) {
    pendingShownCountDeltas.delete(modelId);
    return 0;
  }
  return pending.count;
}

export function settleArenaMatchupShown(modelCounts: Map<string, number>) {
  const now = Date.now();
  for (const [modelId, count] of modelCounts.entries()) {
    if (!modelId || count <= 0) continue;
    const currentCount = getPendingShownCountDelta(modelId, now);
    const next = Math.max(0, currentCount - count);
    const current = pendingShownCountDeltas.get(modelId);
    if (next > 0 && current) {
      pendingShownCountDeltas.set(modelId, {
        count: next,
        expiresAt: current.expiresAt,
      });
    } else {
      pendingShownCountDeltas.delete(modelId);
    }
  }
}

function refreshPromptCoverageForModel(state: ArenaMatchupSamplingState, modelId: string) {
  const promptIds = state.promptIdsByModelId.get(modelId);
  const totalPrompts = state.prompts.length;
  if (totalPrompts <= 0) {
    state.coverage.promptCoverageByModelId.set(modelId, 0);
    return;
  }

  const activePromptIds = promptIds ?? new Set<string>();
  let covered = 0;
  for (const promptId of activePromptIds) {
    const votes = state.coverage.modelPromptDecisiveVotes.get(modelPromptKey(modelId, promptId)) ?? 0;
    if (votes >= PROMPT_COVERAGE_FLOOR) covered += 1;
  }

  state.coverage.promptCoverageByModelId.set(modelId, covered / totalPrompts);
}

export function recordArenaVoteInSamplingCache(input: {
  promptId: string;
  decisive: boolean;
  modelA: Pick<EligibleModel, "id" | "eloRating" | "conservativeRating" | "ratingDeviation">;
  modelB: Pick<EligibleModel, "id" | "eloRating" | "conservativeRating" | "ratingDeviation">;
}) {
  applySamplingStateMutation((state) => {
    for (const nextModel of [input.modelA, input.modelB]) {
      const cachedModel = state.modelsById.get(nextModel.id);
      if (!cachedModel) continue;
      cachedModel.eloRating = nextModel.eloRating;
      cachedModel.conservativeRating = nextModel.conservativeRating;
      cachedModel.ratingDeviation = nextModel.ratingDeviation;
    }

    if (!input.decisive) return;

    const coverage = state.coverage;
    const pair = pairKey(input.modelA.id, input.modelB.id);
    const pairPrompt = pairPromptKey(input.modelA.id, input.modelB.id, input.promptId);
    const previousPairPromptVotes = coverage.pairPromptDecisiveVotes.get(pairPrompt) ?? 0;

    coverage.pairDecisiveVotes.set(pair, (coverage.pairDecisiveVotes.get(pair) ?? 0) + 1);
    coverage.pairPromptDecisiveVotes.set(pairPrompt, previousPairPromptVotes + 1);
    if (previousPairPromptVotes === 0) {
      coverage.pairPromptCounts.set(pair, (coverage.pairPromptCounts.get(pair) ?? 0) + 1);
    }
    coverage.promptDecisiveTotals.set(
      input.promptId,
      (coverage.promptDecisiveTotals.get(input.promptId) ?? 0) + 1,
    );

    for (const modelId of [input.modelA.id, input.modelB.id]) {
      const key = modelPromptKey(modelId, input.promptId);
      coverage.modelPromptDecisiveVotes.set(
        key,
        (coverage.modelPromptDecisiveVotes.get(key) ?? 0) + 1,
      );
      refreshPromptCoverageForModel(state, modelId);
    }
  });
}

export function isDecisiveChoice(choice: string): choice is "A" | "B" {
  return choice === "A" || choice === "B";
}

function emptyCoverageState(): CoverageState {
  return {
    modelPromptDecisiveVotes: new Map(),
    pairDecisiveVotes: new Map(),
    pairPromptCounts: new Map(),
    pairPromptDecisiveVotes: new Map(),
    promptCoverageByModelId: new Map(),
    promptDecisiveTotals: new Map(),
  };
}

function roundDuration(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms * 100) / 100;
}

async function queryArenaMatchupSamplingState(): Promise<ArenaMatchupSamplingResult> {
  const startedAt = performance.now();
  const eligibilityStartedAt = startedAt;
  const rows = await prisma.build.findMany({
    where: {
      gridSize: ARENA_GRID_SIZE,
      palette: ARENA_PALETTE,
      mode: ARENA_MODE,
      model: { enabled: true, isBaseline: false },
      prompt: { active: true },
    },
    select: {
      id: true,
      promptId: true,
      modelId: true,
      gridSize: true,
      palette: true,
      blockCount: true,
      voxelByteSize: true,
      voxelCompressedByteSize: true,
      voxelSha256: true,
      arenaBuildHints: true,
    },
  });

  const modelIdsByPromptId = new Map<string, Set<string>>();
  const promptIdsByModelId = new Map<string, Set<string>>();
  const buildsByModelPromptKey = new Map<string, EligibleBuildMeta>();

  for (const row of rows) {
    const models = modelIdsByPromptId.get(row.promptId) ?? new Set<string>();
    models.add(row.modelId);
    modelIdsByPromptId.set(row.promptId, models);

    const prompts = promptIdsByModelId.get(row.modelId) ?? new Set<string>();
    prompts.add(row.promptId);
    promptIdsByModelId.set(row.modelId, prompts);

    buildsByModelPromptKey.set(modelPromptKey(row.modelId, row.promptId), {
      id: row.id,
      gridSize: row.gridSize,
      palette: row.palette,
      blockCount: row.blockCount,
      voxelByteSize: row.voxelByteSize,
      voxelCompressedByteSize: row.voxelCompressedByteSize,
      voxelSha256: row.voxelSha256,
      arenaBuildHints: row.arenaBuildHints,
    });
  }

  const eligiblePromptIds = Array.from(modelIdsByPromptId.entries())
    .filter(([, modelIds]) => modelIds.size >= 2)
    .map(([promptId]) => promptId);

  if (eligiblePromptIds.length === 0) {
    return {
      state: {
        prompts: [],
        modelsById: new Map(),
        promptIdsByModelId: new Map(),
        buildsByModelPromptKey: new Map(),
        coverage: emptyCoverageState(),
      },
      meta: {
        cacheStatus: "miss",
        eligibilityMs: roundDuration(performance.now() - eligibilityStartedAt),
        coverageMs: 0,
        totalMs: roundDuration(performance.now() - startedAt),
      },
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

  const now = Date.now();
  const modelsById = new Map<string, EligibleModel>(
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
        shownCount: model.shownCount + getPendingShownCountDelta(model.id, now),
      },
    ]),
  );

  const eligiblePrompts = prompts
    .map((prompt) => {
      const modelIds = Array.from(modelIdsByPromptId.get(prompt.id) ?? []);
      const filteredModelIds = modelIds.filter((modelId) => modelsById.has(modelId));
      return {
        id: prompt.id,
        text: prompt.text,
        modelIds: filteredModelIds,
      } satisfies EligiblePrompt;
    })
    .filter((prompt) => prompt.modelIds.length >= 2);

  const filteredPromptIdsByModelId = new Map<string, Set<string>>();
  for (const prompt of eligiblePrompts) {
    for (const modelId of prompt.modelIds) {
      const promptIds = filteredPromptIdsByModelId.get(modelId) ?? new Set<string>();
      promptIds.add(prompt.id);
      filteredPromptIdsByModelId.set(modelId, promptIds);
    }
  }

  const eligibleModelIds = Array.from(filteredPromptIdsByModelId.keys());
  const eligibilityMs = roundDuration(performance.now() - eligibilityStartedAt);
  const coverageStartedAt = performance.now();
  const coverage = await queryCoverageState(eligiblePrompts, eligibleModelIds);

  return {
    state: {
      prompts: eligiblePrompts,
      modelsById,
      promptIdsByModelId: filteredPromptIdsByModelId,
      buildsByModelPromptKey,
      coverage,
    },
    meta: {
      cacheStatus: "miss",
      eligibilityMs,
      coverageMs: roundDuration(performance.now() - coverageStartedAt),
      totalMs: roundDuration(performance.now() - startedAt),
    },
  };
}

async function queryCoverageState(
  eligiblePrompts: EligiblePrompt[],
  eligibleModelIds: string[],
): Promise<CoverageState> {
  if (eligiblePrompts.length === 0 || eligibleModelIds.length === 0) {
    return emptyCoverageState();
  }

  const eligiblePromptIds = eligiblePrompts.map((prompt) => prompt.id);

  const pairPromptRows = await prisma.arenaCoveragePairPrompt.findMany({
    where: {
      promptId: { in: eligiblePromptIds },
      modelLowId: { in: eligibleModelIds },
      modelHighId: { in: eligibleModelIds },
    },
    select: {
      modelLowId: true,
      modelHighId: true,
      promptId: true,
      decisiveVotes: true,
    },
  });

  const modelPromptDecisiveVotes = new Map<string, number>();
  const pairDecisiveVotes = new Map<string, number>();
  const pairPromptCounts = new Map<string, number>();
  const pairPromptDecisiveVotes = new Map<string, number>();
  const promptDecisiveTotals = new Map<string, number>();

  for (const row of pairPromptRows) {
    const pairPromptVotes = toNumber(row.decisiveVotes);
    const pair = pairKey(row.modelLowId, row.modelHighId);
    modelPromptDecisiveVotes.set(
      modelPromptKey(row.modelLowId, row.promptId),
      (modelPromptDecisiveVotes.get(modelPromptKey(row.modelLowId, row.promptId)) ?? 0) +
        pairPromptVotes,
    );
    modelPromptDecisiveVotes.set(
      modelPromptKey(row.modelHighId, row.promptId),
      (modelPromptDecisiveVotes.get(modelPromptKey(row.modelHighId, row.promptId)) ?? 0) +
        pairPromptVotes,
    );
    pairPromptDecisiveVotes.set(
      pairPromptKey(row.modelLowId, row.modelHighId, row.promptId),
      pairPromptVotes,
    );
    pairDecisiveVotes.set(pair, (pairDecisiveVotes.get(pair) ?? 0) + pairPromptVotes);
    pairPromptCounts.set(pair, (pairPromptCounts.get(pair) ?? 0) + 1);
    promptDecisiveTotals.set(
      row.promptId,
      (promptDecisiveTotals.get(row.promptId) ?? 0) + pairPromptVotes,
    );
  }

  const totalPrompts = eligiblePrompts.length;
  const promptCoverageByModelId = new Map<string, number>();
  for (const modelId of eligibleModelIds) {
    let covered = 0;
    for (const prompt of eligiblePrompts) {
      const votes = modelPromptDecisiveVotes.get(modelPromptKey(modelId, prompt.id)) ?? 0;
      if (votes >= PROMPT_COVERAGE_FLOOR) covered += 1;
    }
    promptCoverageByModelId.set(modelId, totalPrompts > 0 ? covered / totalPrompts : 0);
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

export async function getArenaMatchupSamplingStateWithMeta(): Promise<ArenaMatchupSamplingResult> {
  const now = Date.now();
  if (matchupStateCache && matchupStateCache.expiresAt > now) {
    return {
      state: matchupStateCache.value,
      meta: {
        cacheStatus: "hit",
        eligibilityMs: 0,
        coverageMs: 0,
        totalMs: 0,
      },
    };
  }
  if (matchupStateInFlight) {
    const result = await matchupStateInFlight;
    return {
      state: result.state,
      meta: {
        ...result.meta,
        cacheStatus: "inflight",
      },
    };
  }

  const refreshVersion = matchupStateVersion;
  let inFlight: Promise<ArenaMatchupSamplingResult>;
  inFlight = queryArenaMatchupSamplingState()
    .then((result) => {
      const queuedMutations = pendingSamplingStateMutations;
      pendingSamplingStateMutations = [];
      for (const mutation of queuedMutations) {
        mutation(result.state);
      }
      if (matchupStateVersion === refreshVersion) {
        matchupStateCache = {
          value: result.state,
          expiresAt: Date.now() + MATCHUP_STATE_CACHE_TTL_MS,
        };
      }
      return result;
    })
    .finally(() => {
      if (matchupStateInFlight === inFlight) {
        matchupStateInFlight = null;
      }
    });
  matchupStateInFlight = inFlight;

  return matchupStateInFlight;
}

export async function getArenaMatchupSamplingState(): Promise<ArenaMatchupSamplingState> {
  const result = await getArenaMatchupSamplingStateWithMeta();
  return result.state;
}

export async function getArenaPairCoverageByKey(
  modelIds: string[],
  promptIds: string[],
): Promise<Map<string, PairCoverage>> {
  if (modelIds.length < 2 || promptIds.length === 0) {
    return new Map();
  }

  const pairPromptRows = await prisma.arenaCoveragePairPrompt.findMany({
    where: {
      modelLowId: { in: modelIds },
      modelHighId: { in: modelIds },
      promptId: { in: promptIds },
    },
    select: {
      modelLowId: true,
      modelHighId: true,
      decisiveVotes: true,
    },
  });

  const byKey = new Map<string, PairCoverage>();
  for (const row of pairPromptRows) {
    const key = pairKey(row.modelLowId, row.modelHighId);
    const current = byKey.get(key) ?? { decisiveVotes: 0, promptCount: 0 };
    current.decisiveVotes += toNumber(row.decisiveVotes);
    current.promptCount += 1;
    byKey.set(key, current);
  }

  return byKey;
}

type CoverageRebuildSeedRow = {
  modelAId: string;
  modelBId: string;
  promptId: string;
  decisiveVotes: NumberLike;
};

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

async function acquireArenaCoverageLock(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ARENA_COVERAGE_LOCK_KEY})`;
}

async function readCoverageDriftCounts(client: PrismaClient = prisma) {
  const [decisiveVoteCount, pairAggregate] = await Promise.all([
    client.vote.count({
      where: {
        choice: {
          in: ["A", "B"],
        },
      },
    }),
    client.arenaCoveragePair.aggregate({
      _sum: {
        decisiveVotes: true,
      },
    }),
  ]);

  return {
    decisiveVoteCount,
    derivedPairVoteCount: pairAggregate._sum.decisiveVotes ?? 0,
  };
}

async function ensureArenaCoverageTablesCurrent(client: PrismaClient = prisma) {
  if (coverageSyncInFlight) {
    return coverageSyncInFlight;
  }

  coverageSyncInFlight = (async () => {
    const { decisiveVoteCount, derivedPairVoteCount } = await readCoverageDriftCounts(client);
    if (decisiveVoteCount === derivedPairVoteCount) return;
    await rebuildArenaCoverageTables(client);
  })().finally(() => {
    coverageSyncInFlight = null;
  });

  return coverageSyncInFlight;
}

export async function rebuildArenaCoverageTables(client: PrismaClient = prisma): Promise<{
  modelPromptRows: number;
  pairRows: number;
  pairPromptRows: number;
}> {
  return client.$transaction(async (tx) => {
    await acquireArenaCoverageLock(tx);
    const seedRows = await tx.$queryRaw<CoverageRebuildSeedRow[]>`
      SELECT
        matchup."modelAId" AS "modelAId",
        matchup."modelBId" AS "modelBId",
        matchup."promptId" AS "promptId",
        COUNT(*)::int AS "decisiveVotes"
      FROM "Vote" vote
      INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
      WHERE vote.choice IN ('A', 'B')
      GROUP BY matchup."modelAId", matchup."modelBId", matchup."promptId"
    `;

    const modelPromptCounts = new Map<string, number>();
    const pairCounts = new Map<string, number>();
    const pairPromptCounts = new Map<string, number>();

    for (const row of seedRows) {
      const decisiveVotes = toNumber(row.decisiveVotes);
      if (decisiveVotes <= 0) continue;

      modelPromptCounts.set(
        modelPromptKey(row.modelAId, row.promptId),
        (modelPromptCounts.get(modelPromptKey(row.modelAId, row.promptId)) ?? 0) + decisiveVotes,
      );
      modelPromptCounts.set(
        modelPromptKey(row.modelBId, row.promptId),
        (modelPromptCounts.get(modelPromptKey(row.modelBId, row.promptId)) ?? 0) + decisiveVotes,
      );

      const [modelLowId, modelHighId] = orderPairIds(row.modelAId, row.modelBId);
      const pair = pairKey(modelLowId, modelHighId);
      pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + decisiveVotes);
      pairPromptCounts.set(
        pairPromptKey(modelLowId, modelHighId, row.promptId),
        (pairPromptCounts.get(pairPromptKey(modelLowId, modelHighId, row.promptId)) ?? 0) +
          decisiveVotes,
      );
    }

    const modelPromptData = Array.from(modelPromptCounts.entries()).map(([key, decisiveVotes]) => {
      const [modelId, promptId] = key.split("|");
      return {
        modelId,
        promptId,
        decisiveVotes,
      };
    });

    const pairData = Array.from(pairCounts.entries()).map(([key, decisiveVotes]) => {
      const [modelLowId, modelHighId] = key.split("|");
      return {
        modelLowId,
        modelHighId,
        decisiveVotes,
      };
    });

    const pairPromptData = Array.from(pairPromptCounts.entries()).map(([key, decisiveVotes]) => {
      const [modelLowId, modelHighId, promptId] = key.split("|");
      return {
        modelLowId,
        modelHighId,
        promptId,
        decisiveVotes,
      };
    });

    await tx.arenaCoveragePairPrompt.deleteMany();
    await tx.arenaCoveragePair.deleteMany();
    await tx.arenaCoverageModelPrompt.deleteMany();

    for (const chunk of chunkArray(modelPromptData, 500)) {
      if (chunk.length === 0) continue;
      await tx.arenaCoverageModelPrompt.createMany({ data: chunk });
    }
    for (const chunk of chunkArray(pairData, 500)) {
      if (chunk.length === 0) continue;
      await tx.arenaCoveragePair.createMany({ data: chunk });
    }
    for (const chunk of chunkArray(pairPromptData, 500)) {
      if (chunk.length === 0) continue;
      await tx.arenaCoveragePairPrompt.createMany({ data: chunk });
    }
    invalidateArenaCoverageCache();

    return {
      modelPromptRows: modelPromptData.length,
      pairRows: pairData.length,
      pairPromptRows: pairPromptData.length,
    };
  });
}

export async function applyDecisiveVoteCoverageUpdate(
  tx: Prisma.TransactionClient | PrismaClient,
  input: {
    modelAId: string;
    modelBId: string;
    promptId: string;
  },
) {
  const [modelLowId, modelHighId] = orderPairIds(input.modelAId, input.modelBId);
  await tx.$executeRaw`
    INSERT INTO "ArenaCoverageModelPrompt" ("modelId", "promptId", "decisiveVotes")
    VALUES
      (${modelLowId}, ${input.promptId}, 1),
      (${modelHighId}, ${input.promptId}, 1)
    ON CONFLICT ("modelId", "promptId")
    DO UPDATE SET "decisiveVotes" = "ArenaCoverageModelPrompt"."decisiveVotes" + 1
  `;

  await tx.$executeRaw`
    INSERT INTO "ArenaCoveragePair" ("modelLowId", "modelHighId", "decisiveVotes")
    VALUES (${modelLowId}, ${modelHighId}, 1)
    ON CONFLICT ("modelLowId", "modelHighId")
    DO UPDATE SET "decisiveVotes" = "ArenaCoveragePair"."decisiveVotes" + 1
  `;

  await tx.$executeRaw`
    INSERT INTO "ArenaCoveragePairPrompt" (
      "modelLowId",
      "modelHighId",
      "promptId",
      "decisiveVotes"
    )
    VALUES (${modelLowId}, ${modelHighId}, ${input.promptId}, 1)
    ON CONFLICT ("modelLowId", "modelHighId", "promptId")
    DO UPDATE SET "decisiveVotes" = "ArenaCoveragePairPrompt"."decisiveVotes" + 1
  `;
}
