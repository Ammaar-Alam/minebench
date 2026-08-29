import type { CustomBuildJob, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";

type PrismaTx = Prisma.TransactionClient;

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function getCustomBuildJobLeaseSeconds(): number {
  return readIntEnv("CUSTOM_BUILD_JOB_LEASE_SECONDS", 180, 30, 60 * 30);
}

export async function claimNextCustomBuildJob(
  workerId: string,
  client: PrismaClient | PrismaTx = prisma,
): Promise<CustomBuildJob | null> {
  const leaseSeconds = getCustomBuildJobLeaseSeconds();
  const rows = await client.$queryRaw<CustomBuildJob[]>`
    WITH candidate AS (
      SELECT id
      FROM "CustomBuildJob"
      WHERE status = 'queued'::"CustomBuildJobStatus"
        AND "runAfter" <= now()
      ORDER BY priority DESC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "CustomBuildJob" j
    SET status = 'running'::"CustomBuildJobStatus",
        "lockedBy" = ${workerId},
        "lockedAt" = now(),
        "leaseExpiresAt" = now() + (${leaseSeconds}::int * interval '1 second'),
        attempts = attempts + 1,
        "startedAt" = COALESCE("startedAt", now()),
        "updatedAt" = now()
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING j.*;
  `;
  return rows[0] ?? null;
}

export async function renewCustomBuildJobLease(
  jobId: string,
  workerId: string,
  client: PrismaClient | PrismaTx = prisma,
): Promise<boolean> {
  const leaseSeconds = getCustomBuildJobLeaseSeconds();
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "CustomBuildJob"
    SET "leaseExpiresAt" = GREATEST(
          COALESCE("leaseExpiresAt", now()::timestamp),
          (now() + (${leaseSeconds}::int * interval '1 second'))::timestamp
        ),
        "updatedAt" = now()
    WHERE id = ${jobId}
      AND status = 'running'::"CustomBuildJobStatus"
      AND "lockedBy" = ${workerId}
    RETURNING id;
  `;
  return rows.length === 1;
}

export async function extendCustomBuildJobLease(
  jobId: string,
  workerId: string,
  leaseMs: number,
  client: PrismaClient | PrismaTx = prisma,
): Promise<boolean> {
  const result = await client.customBuildJob.updateMany({
    where: {
      id: jobId,
      status: "running",
      lockedBy: workerId,
    },
    data: {
      leaseExpiresAt: new Date(Date.now() + Math.max(0, Math.floor(leaseMs))),
    },
  });
  return result.count === 1;
}

export async function recoverStaleCustomBuildJobLeases(
  client: PrismaClient | PrismaTx = prisma,
): Promise<{ requeued: number; failed: number }> {
  const maybeTransactional = client as PrismaClient;
  if (typeof maybeTransactional.$transaction === "function") {
    return maybeTransactional.$transaction((tx) => recoverStaleCustomBuildJobLeasesInTransaction(tx));
  }
  return recoverStaleCustomBuildJobLeasesInTransaction(client as PrismaTx);
}

async function recoverStaleCustomBuildJobLeasesInTransaction(
  client: PrismaTx,
): Promise<{ requeued: number; failed: number }> {
  await client.customBuildSecret.deleteMany({
    where: {
      expiresAt: { lte: new Date() },
      customBuild: { status: "failed", errorRetryable: true },
    },
  });
  const expiredQueuedRows = await client.$queryRaw<Array<{ id: string; customBuildId: string; type: string }>>`
    UPDATE "CustomBuildJob" j
    SET status = 'failed'::"CustomBuildJobStatus",
        "lockedBy" = NULL,
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        "completedAt" = now(),
        "lastErrorCode" = 'provider_key_expired',
        "lastErrorMessage" = 'Provider key expired before the worker could start.',
        "updatedAt" = now()
    FROM "CustomBuildSecret" s
    WHERE j."customBuildId" = s."customBuildId"
      AND j.status = 'queued'::"CustomBuildJobStatus"
      AND j.type = 'generate'::"CustomBuildJobType"
      AND s."expiresAt" <= now()
    RETURNING j.id, j."customBuildId", j.type::text;
  `;
  for (const row of expiredQueuedRows) {
    await client.customBuild.updateMany({
      where: {
        id: row.customBuildId,
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "failed",
        currentStage: "failed",
        completedAt: new Date(),
        errorCode: "provider_key_expired",
        errorMessage: "Provider key expired before the worker could start.",
        errorRetryable: false,
        objectsDeletedAt: null,
        deletionPendingAt: new Date(),
        deletionError: null,
      },
    });
    await client.customBuildSecret.deleteMany({ where: { customBuildId: row.customBuildId } });
  }

  const requeuedRows = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "CustomBuildJob"
    SET status = 'queued'::"CustomBuildJobStatus",
        "lockedBy" = NULL,
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        "runAfter" = now() + interval '15 seconds',
        "updatedAt" = now()
    WHERE status = 'running'::"CustomBuildJobStatus"
      AND "leaseExpiresAt" < now()
      AND attempts < "maxAttempts"
    RETURNING id;
  `;
  const failedRows = await client.$queryRaw<Array<{ id: string; customBuildId: string; type: string }>>`
    UPDATE "CustomBuildJob"
    SET status = 'failed'::"CustomBuildJobStatus",
        "lockedBy" = NULL,
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        "completedAt" = now(),
        "lastErrorCode" = COALESCE("lastErrorCode", 'lease_expired'),
        "lastErrorMessage" = COALESCE("lastErrorMessage", 'Worker lease expired after maximum attempts.'),
        "updatedAt" = now()
    WHERE status = 'running'::"CustomBuildJobStatus"
      AND "leaseExpiresAt" < now()
      AND attempts >= "maxAttempts"
    RETURNING id, "customBuildId", type::text;
  `;
  for (const row of failedRows) {
    if (row.type !== "generate") continue;
    await client.customBuild.updateMany({
      where: {
        id: row.customBuildId,
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "failed",
        currentStage: "failed",
        completedAt: new Date(),
        errorCode: "lease_expired",
        errorMessage: "Worker lease expired after maximum attempts.",
        errorRetryable: false,
        objectsDeletedAt: null,
        deletionPendingAt: new Date(),
        deletionError: null,
      },
    });
    await client.customBuildSecret.deleteMany({ where: { customBuildId: row.customBuildId } });
  }
  return { requeued: requeuedRows.length, failed: expiredQueuedRows.length + failedRows.length };
}

export async function completeCustomBuildJob(
  jobId: string,
  workerId: string,
  client: PrismaClient | PrismaTx = prisma,
): Promise<void> {
  await client.customBuildJob.updateMany({
    where: {
      id: jobId,
      status: "running",
      lockedBy: workerId,
    },
    data: {
      status: "succeeded",
      completedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      leaseExpiresAt: null,
    },
  });
}

export async function releaseCustomBuildJob(
  jobId: string,
  workerId: string,
  client: PrismaClient | PrismaTx = prisma,
): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ id: string; customBuildId: string; type: string }>>`
    UPDATE "CustomBuildJob"
    SET status = 'queued'::"CustomBuildJobStatus",
        "lockedBy" = NULL,
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        "runAfter" = now(),
        attempts = GREATEST(0, attempts - 1),
        "updatedAt" = now()
    WHERE id = ${jobId}
      AND status = 'running'::"CustomBuildJobStatus"
      AND "lockedBy" = ${workerId}
    RETURNING id, "customBuildId", type::text;
  `;
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (row?.type === "generate" && row.customBuildId) {
    await client.customBuild.updateMany({
      where: {
        id: row.customBuildId,
        status: "running",
      },
      data: {
        status: "queued",
        currentStage: "queued",
      },
    });
  }
  return true;
}

export async function failCustomBuildJob(
  jobId: string,
  workerId: string,
  error: { code: string; message: string },
  client: PrismaClient | PrismaTx = prisma,
  opts: { forceTerminal?: boolean } = {},
): Promise<{ requeued: boolean }> {
  const job = await client.customBuildJob.findFirst({
    where: {
      id: jobId,
      status: "running",
      lockedBy: workerId,
    },
    select: { attempts: true, maxAttempts: true, customBuildId: true, type: true },
  });
  if (!job) return { requeued: false };

  if (!opts.forceTerminal && job.attempts < job.maxAttempts) {
    await client.customBuildJob.updateMany({
      where: {
        id: jobId,
        status: "running",
        lockedBy: workerId,
      },
      data: {
        status: "queued",
        runAfter: new Date(Date.now() + 15_000),
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastErrorCode: error.code,
        lastErrorMessage: redactSensitiveText(error.message),
      },
    });
    return { requeued: true };
  }

  const failedAt = new Date();
  const message = redactSensitiveText(error.message);
  const terminalize = async (tx: PrismaTx) => {
    const failed = await tx.customBuildJob.updateMany({
      where: {
        id: jobId,
        status: "running",
        lockedBy: workerId,
      },
      data: {
        status: "failed",
        completedAt: failedAt,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastErrorCode: error.code,
        lastErrorMessage: message,
      },
    });
    if (failed.count !== 1 || job.type !== "generate") return;
    await tx.customBuild.updateMany({
      where: {
        id: job.customBuildId,
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "failed",
        currentStage: "failed",
        completedAt: failedAt,
        errorCode: error.code,
        errorMessage: message,
        errorRetryable: false,
        objectsDeletedAt: null,
        deletionPendingAt: failedAt,
        deletionError: null,
      },
    });
    await tx.customBuildSecret.deleteMany({ where: { customBuildId: job.customBuildId } });
  };
  const maybeTransactional = client as PrismaClient;
  if (typeof maybeTransactional.$transaction === "function") {
    await maybeTransactional.$transaction(terminalize);
  } else {
    await terminalize(client as PrismaTx);
  }
  return { requeued: false };
}
