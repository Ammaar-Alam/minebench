import type { Prisma, PrismaClient, StealthGenerationResult } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type PrismaTx = Prisma.TransactionClient;

export type StealthGenerationJob = StealthGenerationResult;

const MAX_WORKER_ATTEMPTS = 3;
const RETRY_DELAY_MS = 15_000;

export async function claimNextStealthGenerationJob(
  workerId: string,
  leaseSeconds: number,
  client: PrismaClient | PrismaTx = prisma,
): Promise<StealthGenerationJob | null> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    WITH candidate AS (
      SELECT result.id
      FROM "StealthGenerationResult" result
      JOIN "StealthGenerationRun" run ON run.id = result."runId"
      JOIN "StealthVariant" variant ON variant.id = run."variantId"
      JOIN "StealthExperiment" experiment ON experiment.id = variant."experimentId"
      WHERE result.status = 'QUEUED'::"StealthGenerationResultStatus"
        AND result."runAfter" <= now()
        AND run.status = 'RUNNING'::"StealthGenerationRunStatus"
        AND (
          (variant.source = 'ENDPOINT'::"StealthVariantSource" AND variant."endpointEnabled" = true)
          OR (
            variant.source = 'UPLOAD'::"StealthVariantSource"
            AND result."uploadQueuedAt" IS NOT NULL
            AND result."uploadBucket" IS NOT NULL
            AND result."uploadPath" IS NOT NULL
          )
        )
        AND experiment.status IN (
          'DRAFT'::"StealthExperimentStatus",
          'GENERATING'::"StealthExperimentStatus",
          'READY'::"StealthExperimentStatus"
        )
        AND (
          SELECT COUNT(*)
          FROM "StealthGenerationResult" active
          WHERE active."runId" = result."runId"
            AND active.status IN (
              'GENERATING'::"StealthGenerationResultStatus",
              'VALIDATING'::"StealthGenerationResultStatus"
            )
        ) < LEAST(
          15,
          GREATEST(
            1,
            CASE
              WHEN jsonb_typeof(run.configuration->'concurrency') = 'number'
                THEN (run.configuration->>'concurrency')::int
              ELSE 1
            END
          )
        )
      ORDER BY result."runAfter" ASC, result."createdAt" ASC
      FOR UPDATE OF result, run SKIP LOCKED
      LIMIT 1
    )
    UPDATE "StealthGenerationResult" result
    SET status = 'GENERATING'::"StealthGenerationResultStatus",
        "workerAttempts" = "workerAttempts" + 1,
        "lockedBy" = ${workerId},
        "lockedAt" = now(),
        "leaseExpiresAt" = now() + (${leaseSeconds}::int * interval '1 second'),
        error = NULL,
        "updatedAt" = now()
    FROM candidate
    WHERE result.id = candidate.id
    RETURNING result.id;
  `;
  const id = rows[0]?.id;
  if (!id) return null;
  return client.stealthGenerationResult.findUnique({ where: { id } });
}

export async function renewStealthGenerationJobLease(
  resultId: string,
  workerId: string,
  leaseSeconds: number,
  client: PrismaClient | PrismaTx = prisma,
): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "StealthGenerationResult"
    SET "leaseExpiresAt" = GREATEST(
          COALESCE("leaseExpiresAt", now()::timestamp),
          (now() + (${leaseSeconds}::int * interval '1 second'))::timestamp
        ),
        "updatedAt" = now()
    WHERE id = ${resultId}
      AND status IN (
        'GENERATING'::"StealthGenerationResultStatus",
        'VALIDATING'::"StealthGenerationResultStatus"
      )
      AND "lockedBy" = ${workerId}
    RETURNING id;
  `;
  return rows.length === 1;
}

export async function extendStealthGenerationJobLease(
  resultId: string,
  workerId: string,
  leaseMs: number,
  client: PrismaClient | PrismaTx = prisma,
): Promise<boolean> {
  const result = await client.stealthGenerationResult.updateMany({
    where: {
      id: resultId,
      status: { in: ["GENERATING", "VALIDATING"] },
      lockedBy: workerId,
    },
    data: { leaseExpiresAt: new Date(Date.now() + Math.max(0, Math.floor(leaseMs))) },
  });
  return result.count === 1;
}

export async function failStealthGenerationJob(
  resultId: string,
  workerId: string,
  message: string,
  client: PrismaClient | PrismaTx = prisma,
): Promise<{ runId: string | null; requeued: boolean }> {
  const job = await client.stealthGenerationResult.findFirst({
    where: {
      id: resultId,
      status: { in: ["GENERATING", "VALIDATING"] },
      lockedBy: workerId,
    },
    select: { runId: true, workerAttempts: true },
  });
  if (!job) return { runId: null, requeued: false };
  const requeued = job.workerAttempts < MAX_WORKER_ATTEMPTS;
  const updated = await client.stealthGenerationResult.updateMany({
    where: {
      id: resultId,
      status: { in: ["GENERATING", "VALIDATING"] },
      lockedBy: workerId,
    },
    data: requeued
      ? {
          status: "QUEUED",
          runAfter: new Date(Date.now() + RETRY_DELAY_MS),
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          error: message,
        }
      : {
          status: "FAILED",
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          error: message,
        },
  });
  return updated.count === 1
    ? { runId: job.runId, requeued }
    : { runId: null, requeued: false };
}

export async function recoverStaleStealthGenerationJobLeases(
  leaseSeconds: number,
  client: PrismaClient | PrismaTx = prisma,
): Promise<{ requeued: number; failed: number; failedRunIds: string[] }> {
  const requeued = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "StealthGenerationResult"
    SET status = 'QUEUED'::"StealthGenerationResultStatus",
        "runAfter" = now() + interval '15 seconds',
        "lockedBy" = NULL,
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        "updatedAt" = now()
    WHERE status IN (
        'GENERATING'::"StealthGenerationResultStatus",
        'VALIDATING'::"StealthGenerationResultStatus"
      )
      AND (
        "leaseExpiresAt" < now()
        OR (
          "leaseExpiresAt" IS NULL
          AND "updatedAt" < now() - (${leaseSeconds}::int * interval '1 second')
        )
      )
      AND "workerAttempts" < ${MAX_WORKER_ATTEMPTS}
    RETURNING id;
  `;
  const failed = await client.$queryRaw<Array<{ runId: string }>>`
    UPDATE "StealthGenerationResult"
    SET status = 'FAILED'::"StealthGenerationResultStatus",
        "lockedBy" = NULL,
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        error = COALESCE(error, 'Worker lease expired after maximum attempts.'),
        "updatedAt" = now()
    WHERE status IN (
        'GENERATING'::"StealthGenerationResultStatus",
        'VALIDATING'::"StealthGenerationResultStatus"
      )
      AND (
        "leaseExpiresAt" < now()
        OR (
          "leaseExpiresAt" IS NULL
          AND "updatedAt" < now() - (${leaseSeconds}::int * interval '1 second')
        )
      )
      AND "workerAttempts" >= ${MAX_WORKER_ATTEMPTS}
    RETURNING "runId";
  `;
  return {
    requeued: requeued.length,
    failed: failed.length,
    failedRunIds: [...new Set(failed.map((row) => row.runId))],
  };
}

export async function getStealthGenerationQueueStats(
  client: PrismaClient | PrismaTx = prisma,
): Promise<{ queuedCount: number; oldestRunAfter: Date | null }> {
  const now = new Date();
  const [queuedCount, oldest] = await Promise.all([
    client.stealthGenerationResult.count({
      where: {
        status: "QUEUED",
        runAfter: { lte: now },
        OR: [
          { run: { variant: { source: "ENDPOINT", endpointEnabled: true } } },
          { uploadQueuedAt: { not: null }, run: { variant: { source: "UPLOAD" } } },
        ],
      },
    }),
    client.stealthGenerationResult.findFirst({
      where: {
        status: "QUEUED",
        runAfter: { lte: now },
        OR: [
          { run: { variant: { source: "ENDPOINT", endpointEnabled: true } } },
          { uploadQueuedAt: { not: null }, run: { variant: { source: "UPLOAD" } } },
        ],
      },
      orderBy: { runAfter: "asc" },
      select: { runAfter: true },
    }),
  ]);
  return { queuedCount, oldestRunAfter: oldest?.runAfter ?? null };
}
