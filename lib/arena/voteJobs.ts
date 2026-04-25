import { Prisma } from "@prisma/client";
import { conservativeScore, updateRatingPair } from "@/lib/arena/rating";
import {
  isDecisiveChoice,
  recordArenaVoteInSamplingCache,
} from "@/lib/arena/coverage";
import { invalidateArenaStatsCache } from "@/lib/arena/stats";
import { prisma } from "@/lib/prisma";
import { ARENA_WRITE_RETRY_MAX_ATTEMPTS, withArenaWriteRetry } from "@/lib/arena/writeRetry";

function readPositiveIntEnv(name: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  // bad env should not stall the drainer
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

const JOB_TX_MAX_WAIT_MS = readPositiveIntEnv("ARENA_VOTE_JOB_TX_MAX_WAIT_MS", 1000, 10000);
const JOB_TX_TIMEOUT_MS = readPositiveIntEnv("ARENA_VOTE_JOB_TX_TIMEOUT_MS", 8000, 30000);
const JOB_BATCH_LIMIT = readPositiveIntEnv("ARENA_VOTE_JOB_BATCH_LIMIT", 128, 512);
const JOB_DRAIN_MAX_JOBS = readPositiveIntEnv("ARENA_VOTE_JOB_DRAIN_MAX_JOBS", 10000, 50000);
const JOB_DRAIN_MAX_MS = readPositiveIntEnv("ARENA_VOTE_JOB_DRAIN_MAX_MS", 50000, 300000);
const JOB_DRAIN_MIN_BATCH_BUDGET_MS =
  (JOB_TX_MAX_WAIT_MS + JOB_TX_TIMEOUT_MS + 250) * ARENA_WRITE_RETRY_MAX_ATTEMPTS;
const JOB_CONTINUE_DELAY_MS = 75;
const JOB_RETRY_DELAY_MS = 250;
const VOTE_JOB_DRAIN_LOCK_KEY = 860103;

type PendingArenaVoteJob = {
  id: string;
  promptId: string;
  modelAId: string;
  modelBId: string;
  choice: string;
};

type LockedModelRow = {
  id: string;
  eloRating: number;
  glickoRd: number;
  glickoVolatility: number;
};

type MutableModelState = LockedModelRow & {
  conservativeRating: number;
};

type ModelUpdatePlan = {
  id: string;
  data: Prisma.ModelUpdateInput;
};

type VoteCacheUpdate = {
  decisive: boolean;
  promptId: string;
  modelA: {
    id: string;
    eloRating: number;
    conservativeRating: number;
    ratingDeviation: number;
  };
  modelB: {
    id: string;
    eloRating: number;
    conservativeRating: number;
    ratingDeviation: number;
  };
};

type CounterIncrements = {
  winCount: number;
  lossCount: number;
  drawCount: number;
  bothBadCount: number;
};

type CoveragePersistUpdate = {
  promptId: string;
  modelAId: string;
  modelBId: string;
  count: number;
};

type VoteJobBatchResult = {
  processedCount: number;
  cacheUpdates: VoteCacheUpdate[];
  lockSkipped?: boolean;
};

export type ArenaVoteJobDrainResult = {
  processedCount: number;
  batches: number;
  lockSkipped: boolean;
};

const globalForArenaVoteJobs = globalThis as typeof globalThis & {
  arenaVoteJobDrainPromise?: Promise<void> | null;
  arenaVoteJobDrainRequestedDuringRun?: boolean;
};

function orderPairIds(modelAId: string, modelBId: string): [string, string] {
  return modelAId < modelBId ? [modelAId, modelBId] : [modelBId, modelAId];
}

function coveragePersistKey(input: Pick<CoveragePersistUpdate, "modelAId" | "modelBId" | "promptId">): string {
  const [modelLowId, modelHighId] = orderPairIds(input.modelAId, input.modelBId);
  return `${modelLowId}|${modelHighId}|${input.promptId}`;
}

function emptyCounterIncrements(): CounterIncrements {
  return {
    winCount: 0,
    lossCount: 0,
    drawCount: 0,
    bothBadCount: 0,
  };
}

function orderModelUpdatePlans(plans: ModelUpdatePlan[]): ModelUpdatePlan[] {
  return [...plans].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function applyOrderedModelUpdates(
  tx: Prisma.TransactionClient,
  plans: ModelUpdatePlan[],
) {
  for (const plan of orderModelUpdatePlans(plans)) {
    await tx.model.update({
      where: { id: plan.id },
      data: plan.data,
    });
  }
}

async function loadModelsForVoteJobs(
  tx: Prisma.TransactionClient,
  modelIds: string[],
): Promise<Map<string, LockedModelRow>> {
  const orderedIds = Array.from(new Set(modelIds)).sort();
  if (orderedIds.length === 0) return new Map();

  const rows = await tx.$queryRaw<LockedModelRow[]>(Prisma.sql`
    SELECT
      "id",
      "eloRating",
      "glickoRd",
      "glickoVolatility"
    FROM "Model"
    WHERE "id" IN (${Prisma.join(orderedIds)})
    ORDER BY "id" ASC
    FOR UPDATE
  `);

  if (rows.length !== orderedIds.length) {
    throw new Error("Vote models not found");
  }

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        eloRating: Number(row.eloRating),
        glickoRd: Number(row.glickoRd),
        glickoVolatility: Number(row.glickoVolatility),
      },
    ]),
  );
}

async function tryAcquireVoteJobDrainLock(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(${VOTE_JOB_DRAIN_LOCK_KEY}) AS "locked"
  `);
  return rows[0]?.locked === true;
}

async function applyCoveragePersistUpdates(
  tx: Prisma.TransactionClient,
  updates: CoveragePersistUpdate[],
) {
  if (updates.length === 0) return;

  const modelPromptIncrements = new Map<string, { modelId: string; promptId: string; count: number }>();
  const pairIncrements = new Map<string, { modelLowId: string; modelHighId: string; count: number }>();
  const pairPromptIncrements = new Map<
    string,
    { modelLowId: string; modelHighId: string; promptId: string; count: number }
  >();

  const addModelPrompt = (modelId: string, promptId: string, count: number) => {
    const key = `${modelId}|${promptId}`;
    const current = modelPromptIncrements.get(key);
    if (current) {
      current.count += count;
      return;
    }
    modelPromptIncrements.set(key, { modelId, promptId, count });
  };

  for (const update of updates) {
    const [modelLowId, modelHighId] = orderPairIds(update.modelAId, update.modelBId);
    addModelPrompt(modelLowId, update.promptId, update.count);
    addModelPrompt(modelHighId, update.promptId, update.count);

    const pairKey = `${modelLowId}|${modelHighId}`;
    const pair = pairIncrements.get(pairKey);
    if (pair) {
      pair.count += update.count;
    } else {
      pairIncrements.set(pairKey, { modelLowId, modelHighId, count: update.count });
    }

    const pairPromptKey = `${pairKey}|${update.promptId}`;
    const pairPrompt = pairPromptIncrements.get(pairPromptKey);
    if (pairPrompt) {
      pairPrompt.count += update.count;
    } else {
      pairPromptIncrements.set(pairPromptKey, {
        modelLowId,
        modelHighId,
        promptId: update.promptId,
        count: update.count,
      });
    }
  }

  const modelPromptRows = Array.from(modelPromptIncrements.values());
  if (modelPromptRows.length > 0) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ArenaCoverageModelPrompt" ("modelId", "promptId", "decisiveVotes")
      VALUES ${Prisma.join(
        modelPromptRows.map((row) => Prisma.sql`(${row.modelId}, ${row.promptId}, ${row.count})`),
      )}
      ON CONFLICT ("modelId", "promptId")
      DO UPDATE SET "decisiveVotes" =
        "ArenaCoverageModelPrompt"."decisiveVotes" + EXCLUDED."decisiveVotes"
    `);
  }

  const pairRows = Array.from(pairIncrements.values());
  if (pairRows.length > 0) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ArenaCoveragePair" ("modelLowId", "modelHighId", "decisiveVotes")
      VALUES ${Prisma.join(
        pairRows.map((row) => Prisma.sql`(${row.modelLowId}, ${row.modelHighId}, ${row.count})`),
      )}
      ON CONFLICT ("modelLowId", "modelHighId")
      DO UPDATE SET "decisiveVotes" =
        "ArenaCoveragePair"."decisiveVotes" + EXCLUDED."decisiveVotes"
    `);
  }

  const pairPromptRows = Array.from(pairPromptIncrements.values());
  if (pairPromptRows.length > 0) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ArenaCoveragePairPrompt" (
        "modelLowId",
        "modelHighId",
        "promptId",
        "decisiveVotes"
      )
      VALUES ${Prisma.join(
        pairPromptRows.map(
          (row) => Prisma.sql`(${row.modelLowId}, ${row.modelHighId}, ${row.promptId}, ${row.count})`,
        ),
      )}
      ON CONFLICT ("modelLowId", "modelHighId", "promptId")
      DO UPDATE SET "decisiveVotes" =
        "ArenaCoveragePairPrompt"."decisiveVotes" + EXCLUDED."decisiveVotes"
    `);
  }
}

async function processArenaVoteJobBatch(limit = JOB_BATCH_LIMIT): Promise<VoteJobBatchResult> {
  const batchLimit = Math.max(1, Math.min(Math.max(1, JOB_BATCH_LIMIT), Math.floor(limit)));
  const result = await withArenaWriteRetry<VoteJobBatchResult>(() =>
    prisma.$transaction(
      async (tx) => {
        const hasDrainLock = await tryAcquireVoteJobDrainLock(tx);
        if (!hasDrainLock) {
          return {
            processedCount: 0,
            cacheUpdates: [],
            lockSkipped: true,
          };
        }

        const jobs = await tx.$queryRaw<PendingArenaVoteJob[]>(Prisma.sql`
          SELECT
            "id",
            "promptId",
            "modelAId",
            "modelBId",
            "choice"
          FROM "ArenaVoteJob"
          WHERE "processedAt" IS NULL
          ORDER BY "createdAt" ASC
          LIMIT ${batchLimit}
          FOR UPDATE SKIP LOCKED
        `);

        if (jobs.length === 0) {
          return {
            processedCount: 0,
            cacheUpdates: [],
          };
        }

        const lockedModels = await loadModelsForVoteJobs(
          tx,
          jobs.flatMap((job) => [job.modelAId, job.modelBId]),
        );
        const modelStates = new Map<string, MutableModelState>(
          Array.from(lockedModels.entries()).map(([id, model]) => [
            id,
            {
              ...model,
              conservativeRating: conservativeScore(model.eloRating, model.glickoRd),
            },
          ]),
        );
        const counterIncrements = new Map<string, CounterIncrements>();
        const cacheUpdates: VoteCacheUpdate[] = [];
        const coveragePersistUpdates = new Map<string, CoveragePersistUpdate>();

        const countersForModel = (modelId: string) => {
          let counters = counterIncrements.get(modelId);
          if (!counters) {
            counters = emptyCounterIncrements();
            counterIncrements.set(modelId, counters);
          }
          return counters;
        };

        const addCoveragePersistUpdate = (job: PendingArenaVoteJob) => {
          const key = coveragePersistKey(job);
          const existing = coveragePersistUpdates.get(key);
          if (existing) {
            existing.count += 1;
            return;
          }
          coveragePersistUpdates.set(key, {
            modelAId: job.modelAId,
            modelBId: job.modelBId,
            promptId: job.promptId,
            count: 1,
          });
        };

        for (const job of jobs) {
          const modelA = modelStates.get(job.modelAId);
          const modelB = modelStates.get(job.modelBId);
          if (!modelA || !modelB) {
            throw new Error("Vote models not found");
          }

          if (job.choice === "BOTH_BAD") {
            countersForModel(job.modelAId).bothBadCount += 1;
            countersForModel(job.modelBId).bothBadCount += 1;
            continue;
          }

          const outcome = job.choice === "A" ? "A_WIN" : job.choice === "B" ? "B_WIN" : "DRAW";
          const updated = updateRatingPair({
            a: {
              rating: modelA.eloRating,
              rd: modelA.glickoRd,
              volatility: modelA.glickoVolatility,
            },
            b: {
              rating: modelB.eloRating,
              rd: modelB.glickoRd,
              volatility: modelB.glickoVolatility,
            },
            outcome,
          });

          modelA.eloRating = updated.a.rating;
          modelA.glickoRd = updated.a.rd;
          modelA.glickoVolatility = updated.a.volatility;
          modelA.conservativeRating = conservativeScore(updated.a.rating, updated.a.rd);
          modelB.eloRating = updated.b.rating;
          modelB.glickoRd = updated.b.rd;
          modelB.glickoVolatility = updated.b.volatility;
          modelB.conservativeRating = conservativeScore(updated.b.rating, updated.b.rd);

          const countersA = countersForModel(job.modelAId);
          const countersB = countersForModel(job.modelBId);
          if (isDecisiveChoice(job.choice)) {
            if (outcome === "A_WIN") {
              countersA.winCount += 1;
              countersB.lossCount += 1;
            } else {
              countersA.lossCount += 1;
              countersB.winCount += 1;
            }
            addCoveragePersistUpdate(job);
          } else {
            countersA.drawCount += 1;
            countersB.drawCount += 1;
          }

          cacheUpdates.push({
            decisive: isDecisiveChoice(job.choice),
            promptId: job.promptId,
            modelA: {
              id: job.modelAId,
              eloRating: modelA.eloRating,
              conservativeRating: modelA.conservativeRating,
              ratingDeviation: modelA.glickoRd,
            },
            modelB: {
              id: job.modelBId,
              eloRating: modelB.eloRating,
              conservativeRating: modelB.conservativeRating,
              ratingDeviation: modelB.glickoRd,
            },
          });
        }

        const modelUpdatePlans = Array.from(modelStates.values()).map((model) => {
          const counters = counterIncrements.get(model.id) ?? emptyCounterIncrements();
          const data: Prisma.ModelUpdateInput = {
            eloRating: model.eloRating,
            glickoRd: model.glickoRd,
            glickoVolatility: model.glickoVolatility,
            conservativeRating: model.conservativeRating,
          };
          if (counters.winCount > 0) data.winCount = { increment: counters.winCount };
          if (counters.lossCount > 0) data.lossCount = { increment: counters.lossCount };
          if (counters.drawCount > 0) data.drawCount = { increment: counters.drawCount };
          if (counters.bothBadCount > 0) data.bothBadCount = { increment: counters.bothBadCount };
          return { id: model.id, data };
        });

        await applyOrderedModelUpdates(tx, modelUpdatePlans);
        await applyCoveragePersistUpdates(tx, Array.from(coveragePersistUpdates.values()));
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ArenaVoteJob"
          SET "processedAt" = CURRENT_TIMESTAMP
          WHERE "id" IN (${Prisma.join(jobs.map((job) => job.id))})
        `);

        return { processedCount: jobs.length, cacheUpdates };
      },
      {
        maxWait: JOB_TX_MAX_WAIT_MS,
        timeout: JOB_TX_TIMEOUT_MS,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    ),
  );

  if (result.processedCount <= 0) return result;

  invalidateArenaStatsCache();
  for (const cacheUpdate of result.cacheUpdates) {
    recordArenaVoteInSamplingCache(cacheUpdate);
  }
  return result;
}

export async function drainArenaVoteJobs(opts?: {
  maxJobs?: number;
  maxMs?: number;
}): Promise<ArenaVoteJobDrainResult> {
  let processedCount = 0;
  let batches = 0;
  let lockSkipped = false;
  const maxJobs = Math.max(1, opts?.maxJobs ?? JOB_DRAIN_MAX_JOBS);
  const maxMs = Math.max(250, opts?.maxMs ?? JOB_DRAIN_MAX_MS);
  const deadlineAt = Date.now() + maxMs;

  while (processedCount < maxJobs) {
    const remainingMs = deadlineAt - Date.now();
    // always let a fresh drain try one batch
    if (remainingMs < JOB_DRAIN_MIN_BATCH_BUDGET_MS && processedCount > 0) break;
    const remainingJobs = maxJobs - processedCount;
    const result = await processArenaVoteJobBatch(remainingJobs);
    if (result.lockSkipped) {
      lockSkipped = true;
      break;
    }
    const processed = result.processedCount;
    if (processed <= 0) break;
    processedCount += processed;
    batches += 1;
    if (processed < Math.max(1, JOB_BATCH_LIMIT)) break;
  }

  return { processedCount, batches, lockSkipped };
}

export async function scheduleArenaVoteJobDrain(): Promise<void> {
  if (globalForArenaVoteJobs.arenaVoteJobDrainPromise) {
    globalForArenaVoteJobs.arenaVoteJobDrainRequestedDuringRun = true;
    await globalForArenaVoteJobs.arenaVoteJobDrainPromise;
    return;
  }

  globalForArenaVoteJobs.arenaVoteJobDrainRequestedDuringRun = false;
  let scheduleImmediateFollowup = false;
  let scheduleRetry = false;
  globalForArenaVoteJobs.arenaVoteJobDrainPromise = (async () => {
    try {
      const result = await drainArenaVoteJobs({ maxJobs: JOB_BATCH_LIMIT });
      scheduleImmediateFollowup = result.processedCount >= Math.max(1, JOB_BATCH_LIMIT);
    } catch (error) {
      console.warn("arena vote job drain failed", error);
      scheduleRetry = true;
    } finally {
      const requestedDuringRun = globalForArenaVoteJobs.arenaVoteJobDrainRequestedDuringRun === true;
      globalForArenaVoteJobs.arenaVoteJobDrainRequestedDuringRun = false;
      globalForArenaVoteJobs.arenaVoteJobDrainPromise = null;
      if (scheduleImmediateFollowup || requestedDuringRun) {
        setTimeout(() => {
          void scheduleArenaVoteJobDrain();
        }, JOB_CONTINUE_DELAY_MS);
      } else if (scheduleRetry) {
        setTimeout(() => {
          void scheduleArenaVoteJobDrain();
        }, JOB_RETRY_DELAY_MS);
      }
    }
  })();

  await globalForArenaVoteJobs.arenaVoteJobDrainPromise;
}
