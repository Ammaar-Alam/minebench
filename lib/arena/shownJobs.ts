import { Prisma } from "@prisma/client";
import { ARENA_SHOWN_JOB_DRAIN_LOCK_KEY } from "@/lib/arena/advisoryLocks";
import { persistArenaMatchupShown, settleArenaMatchupShown } from "@/lib/arena/coverage";
import { invalidateArenaStatsCache } from "@/lib/arena/stats";
import { ARENA_WRITE_RETRY_MAX_ATTEMPTS, withArenaWriteRetry } from "@/lib/arena/writeRetry";
import { prisma } from "@/lib/prisma";

function readPositiveIntEnv(name: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  // bad env should not stall shown-count drains
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

const JOB_TX_MAX_WAIT_MS = readPositiveIntEnv("ARENA_SHOWN_JOB_TX_MAX_WAIT_MS", 1000, 10000);
const JOB_TX_TIMEOUT_MS = readPositiveIntEnv("ARENA_SHOWN_JOB_TX_TIMEOUT_MS", 8000, 30000);
const JOB_BATCH_LIMIT = readPositiveIntEnv("ARENA_SHOWN_JOB_BATCH_LIMIT", 256, 1024);
const JOB_DRAIN_MAX_JOBS = readPositiveIntEnv("ARENA_SHOWN_JOB_DRAIN_MAX_JOBS", 10000, 50000);
const JOB_DRAIN_MAX_MS = readPositiveIntEnv("ARENA_SHOWN_JOB_DRAIN_MAX_MS", 50000, 300000);
const JOB_DRAIN_MIN_BATCH_BUDGET_MS =
  (JOB_TX_MAX_WAIT_MS + JOB_TX_TIMEOUT_MS + 250) * ARENA_WRITE_RETRY_MAX_ATTEMPTS;
const JOB_CONTINUE_DELAY_MS = 75;
const JOB_RETRY_DELAY_MS = 250;

type PendingArenaShownJob = {
  id: string;
  modelId: string;
  count: number;
};

type ShownJobBatchResult = {
  processedCount: number;
  increments: Map<string, number>;
  lockSkipped?: boolean;
};

export type ArenaShownJobDrainResult = {
  processedCount: number;
  batches: number;
  lockSkipped: boolean;
};

const globalForArenaShownJobs = globalThis as typeof globalThis & {
  arenaShownJobDrainPromise?: Promise<void> | null;
  arenaShownJobDrainRequestedDuringRun?: boolean;
};

function shownCountIncrementsForModels(modelIds: string[]): Map<string, number> {
  const increments = new Map<string, number>();
  for (const modelId of modelIds) {
    if (!modelId) continue;
    increments.set(modelId, (increments.get(modelId) ?? 0) + 1);
  }
  return increments;
}

async function enqueueArenaShownJobs(modelIds: string[]) {
  const increments = shownCountIncrementsForModels(modelIds);
  const rows = Array.from(increments.entries()).map(([modelId, count]) => ({
    id: crypto.randomUUID(),
    modelId,
    count,
  }));
  if (rows.length === 0) return;

  await withArenaWriteRetry(() =>
    prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ArenaShownJob" ("id", "modelId", "count")
      VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(${row.id}, ${row.modelId}, ${row.count})`))}
    `),
  );
}

async function tryAcquireShownJobDrainLock(tx: Prisma.TransactionClient): Promise<boolean> {
  // one shown-count drain owns model counter writes at a time
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(${ARENA_SHOWN_JOB_DRAIN_LOCK_KEY}) AS "locked"
  `);
  return rows[0]?.locked === true;
}

async function processArenaShownJobBatch(limit = JOB_BATCH_LIMIT): Promise<ShownJobBatchResult> {
  const batchLimit = Math.max(1, Math.min(Math.max(1, JOB_BATCH_LIMIT), Math.floor(limit)));
  const result = await withArenaWriteRetry<ShownJobBatchResult>(() =>
    prisma.$transaction(
      async (tx) => {
        const hasDrainLock = await tryAcquireShownJobDrainLock(tx);
        if (!hasDrainLock) {
          return {
            processedCount: 0,
            increments: new Map(),
            lockSkipped: true,
          };
        }

        // skip locked lets overlapping drains exit quickly
        const jobs = await tx.$queryRaw<PendingArenaShownJob[]>(Prisma.sql`
          SELECT
            "id",
            "modelId",
            "count"
          FROM "ArenaShownJob"
          WHERE "processedAt" IS NULL
          ORDER BY "createdAt" ASC
          LIMIT ${batchLimit}
          FOR UPDATE SKIP LOCKED
        `);

        if (jobs.length === 0) {
          return {
            processedCount: 0,
            increments: new Map(),
          };
        }

        const increments = new Map<string, number>();
        for (const job of jobs) {
          const count = Number(job.count);
          if (!job.modelId || !Number.isFinite(count) || count <= 0) continue;
          increments.set(job.modelId, (increments.get(job.modelId) ?? 0) + Math.floor(count));
        }
        const rows = Array.from(increments.entries());

        if (rows.length > 0) {
          // grouped model updates keep queued impressions cheap to drain
          await tx.$executeRaw(Prisma.sql`
            UPDATE "Model" AS model
            SET "shownCount" = model."shownCount" + shown."count"
            FROM (
              VALUES ${Prisma.join(rows.map(([modelId, count]) => Prisma.sql`(${modelId}, ${count})`))}
            ) AS shown("id", "count")
            WHERE model."id" = shown."id"
          `);
        }

        await tx.$executeRaw(Prisma.sql`
          UPDATE "ArenaShownJob"
          SET "processedAt" = CURRENT_TIMESTAMP
          WHERE "id" IN (${Prisma.join(jobs.map((job) => job.id))})
        `);

        return { processedCount: jobs.length, increments };
      },
      {
        maxWait: JOB_TX_MAX_WAIT_MS,
        timeout: JOB_TX_TIMEOUT_MS,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    ),
  );

  if (result.processedCount <= 0) return result;

  settleArenaMatchupShown(result.increments);
  invalidateArenaStatsCache();
  return result;
}

export async function drainArenaShownJobs(opts?: {
  maxJobs?: number;
  maxMs?: number;
}): Promise<ArenaShownJobDrainResult> {
  // bounded drains keep after hooks short under traffic spikes
  let processedCount = 0;
  let batches = 0;
  let lockSkipped = false;
  const maxJobs = Math.max(1, opts?.maxJobs ?? JOB_DRAIN_MAX_JOBS);
  const maxMs = Math.max(250, opts?.maxMs ?? JOB_DRAIN_MAX_MS);
  const deadlineAt = Date.now() + maxMs;

  while (processedCount < maxJobs) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < JOB_DRAIN_MIN_BATCH_BUDGET_MS && processedCount > 0) break;
    const remainingJobs = maxJobs - processedCount;
    const result = await processArenaShownJobBatch(remainingJobs);
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

export async function scheduleArenaShownJobDrain(): Promise<void> {
  if (globalForArenaShownJobs.arenaShownJobDrainPromise) {
    // collapse overlapping after hooks into one follow-up drain
    globalForArenaShownJobs.arenaShownJobDrainRequestedDuringRun = true;
    await globalForArenaShownJobs.arenaShownJobDrainPromise;
    return;
  }

  globalForArenaShownJobs.arenaShownJobDrainRequestedDuringRun = false;
  let scheduleImmediateFollowup = false;
  let scheduleRetry = false;
  globalForArenaShownJobs.arenaShownJobDrainPromise = (async () => {
    try {
      // scheduled drains take one batch and reschedule when backlog remains
      const result = await drainArenaShownJobs({ maxJobs: JOB_BATCH_LIMIT });
      scheduleImmediateFollowup = result.processedCount >= Math.max(1, JOB_BATCH_LIMIT);
    } catch (error) {
      console.warn("arena shown job drain failed", error);
      scheduleRetry = true;
    } finally {
      const requestedDuringRun = globalForArenaShownJobs.arenaShownJobDrainRequestedDuringRun === true;
      globalForArenaShownJobs.arenaShownJobDrainRequestedDuringRun = false;
      globalForArenaShownJobs.arenaShownJobDrainPromise = null;
      if (scheduleImmediateFollowup || requestedDuringRun) {
        setTimeout(() => {
          void scheduleArenaShownJobDrain();
        }, JOB_CONTINUE_DELAY_MS);
      } else if (scheduleRetry) {
        setTimeout(() => {
          void scheduleArenaShownJobDrain();
        }, JOB_RETRY_DELAY_MS);
      }
    }
  })();

  await globalForArenaShownJobs.arenaShownJobDrainPromise;
}

export async function persistArenaMatchupShownDurably(modelIds: string[]) {
  try {
    await enqueueArenaShownJobs(modelIds);
  } catch (error) {
    // keep pre-migration previews working if the queue is unavailable
    await withArenaWriteRetry(() => persistArenaMatchupShown(modelIds));
    console.warn("arena shown job enqueue failed; used direct shown-count persist", error);
    return;
  }

  await scheduleArenaShownJobDrain();
}

export async function getArenaShownJobStatus() {
  try {
    const [pendingRows, oldestRows] = await Promise.all([
      prisma.$queryRaw<Array<{ count: bigint | number }>>(Prisma.sql`
        SELECT COUNT(*) AS "count"
        FROM "ArenaShownJob"
        WHERE "processedAt" IS NULL
      `),
      prisma.$queryRaw<Array<{ createdAt: Date }>>(Prisma.sql`
        SELECT "createdAt"
        FROM "ArenaShownJob"
        WHERE "processedAt" IS NULL
        ORDER BY "createdAt" ASC
        LIMIT 1
      `),
    ]);

    const pendingCount = Number(pendingRows[0]?.count ?? 0);
    const oldestPending = oldestRows[0]?.createdAt ?? null;
    return {
      pendingCount,
      oldestPendingAgeMs: oldestPending ? Math.max(0, Date.now() - oldestPending.getTime()) : null,
      error: null,
    };
  } catch (error) {
    return {
      pendingCount: null,
      oldestPendingAgeMs: null,
      error: error instanceof Error ? error.message : "shown job status lookup failed",
    };
  }
}
