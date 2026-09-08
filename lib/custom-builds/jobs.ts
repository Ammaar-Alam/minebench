import { Prisma, type CustomBuildJob, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import { enqueueGenerationNotification, lockNotificationAccounts } from "@/lib/notifications/service";

type PrismaTx = Prisma.TransactionClient;
type OwnerScopedRow = { ownerId: string | null };
type TerminalBuildJobRow = { id: string; customBuildId: string; type: string };
type TerminalBuildJobCandidate = TerminalBuildJobRow & OwnerScopedRow;

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
  const recoveryCutoff = new Date();
  const expiredSecretRows = await client.$queryRaw<Array<{ customBuildId: string } & OwnerScopedRow>>`
    SELECT s."customBuildId", b."ownerId"
    FROM "CustomBuildSecret" s
    JOIN "CustomBuild" b ON b.id = s."customBuildId"
    WHERE s."expiresAt" <= ${recoveryCutoff}::timestamp
      AND b.status = 'failed'::"CustomBuildStatus"
      AND b."errorRetryable" = true
  `;
  const expiredQueuedCandidates = await client.$queryRaw<TerminalBuildJobCandidate[]>`
    SELECT j.id, j."customBuildId", j.type::text, b."ownerId"
    FROM "CustomBuildJob" j
    JOIN "CustomBuildSecret" s ON s."customBuildId" = j."customBuildId"
    JOIN "CustomBuild" b ON b.id = j."customBuildId"
    WHERE j.status = 'queued'::"CustomBuildJobStatus"
      AND j.type = 'generate'::"CustomBuildJobType"
      AND s."expiresAt" <= ${recoveryCutoff}::timestamp
  `;
  const requeuedCandidates = await client.$queryRaw<Array<{ id: string } & OwnerScopedRow>>`
    SELECT j.id, b."ownerId"
    FROM "CustomBuildJob" j
    JOIN "CustomBuild" b ON b.id = j."customBuildId"
    WHERE j.status = 'running'::"CustomBuildJobStatus"
      AND j."leaseExpiresAt" < now()
      AND j.attempts < j."maxAttempts"
  `;
  const failedCandidates = await client.$queryRaw<TerminalBuildJobCandidate[]>`
    SELECT j.id, j."customBuildId", j.type::text, b."ownerId"
    FROM "CustomBuildJob" j
    JOIN "CustomBuild" b ON b.id = j."customBuildId"
    WHERE j.status = 'running'::"CustomBuildJobStatus"
      AND j."leaseExpiresAt" < now()
      AND j.attempts >= j."maxAttempts"
  `;
  await lockNotificationAccounts(client, [
    ...expiredSecretRows.map((row) => row.ownerId),
    ...expiredQueuedCandidates.map((row) => row.ownerId),
    ...requeuedCandidates.map((row) => row.ownerId),
    ...failedCandidates.map((row) => row.ownerId),
  ]);
  if (expiredSecretRows.length > 0) {
    await client.customBuildSecret.deleteMany({
      where: {
        customBuildId: { in: expiredSecretRows.map((row) => row.customBuildId) },
        expiresAt: { lte: recoveryCutoff },
        customBuild: { status: "failed", errorRetryable: true },
      },
    });
  }

  const expiredQueuedRows = expiredQueuedCandidates.length > 0
    ? await client.$queryRaw<TerminalBuildJobRow[]>`
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
      WHERE j.id IN (${Prisma.join(expiredQueuedCandidates.map((row) => row.id))})
        AND j."customBuildId" = s."customBuildId"
        AND j.status = 'queued'::"CustomBuildJobStatus"
        AND j.type = 'generate'::"CustomBuildJobType"
        AND s."expiresAt" <= ${recoveryCutoff}::timestamp
      RETURNING j.id, j."customBuildId", j.type::text
    `
    : [];
  for (const row of expiredQueuedRows) {
    const failed = await client.customBuild.updateMany({
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
    if (failed.count === 1) await enqueueGenerationNotification(client, row.customBuildId);
    await client.customBuildSecret.deleteMany({ where: { customBuildId: row.customBuildId } });
  }

  const requeuedRows = requeuedCandidates.length > 0
    ? await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "CustomBuildJob" j
    SET status = 'queued'::"CustomBuildJobStatus",
        "lockedBy" = NULL,
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        "runAfter" = now() + interval '15 seconds',
        "updatedAt" = now()
    WHERE j.id IN (${Prisma.join(requeuedCandidates.map((row) => row.id))})
      AND j.status = 'running'::"CustomBuildJobStatus"
      AND j."leaseExpiresAt" < now()
      AND j.attempts < j."maxAttempts"
    RETURNING j.id;
  `
    : [];
  const failedRows = failedCandidates.length > 0
    ? await client.$queryRaw<TerminalBuildJobRow[]>`
      UPDATE "CustomBuildJob" j
      SET status = 'failed'::"CustomBuildJobStatus",
          "lockedBy" = NULL,
          "lockedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "completedAt" = now(),
          "lastErrorCode" = COALESCE("lastErrorCode", 'lease_expired'),
          "lastErrorMessage" = COALESCE("lastErrorMessage", 'Worker lease expired after maximum attempts.'),
          "updatedAt" = now()
      WHERE j.id IN (${Prisma.join(failedCandidates.map((row) => row.id))})
        AND j.status = 'running'::"CustomBuildJobStatus"
        AND j."leaseExpiresAt" < now()
        AND j.attempts >= j."maxAttempts"
      RETURNING j.id, j."customBuildId", j.type::text
    `
    : [];
  for (const row of failedRows) {
    if (row.type !== "generate") continue;
    const failed = await client.customBuild.updateMany({
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
    if (failed.count === 1) await enqueueGenerationNotification(client, row.customBuildId);
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
    select: {
      attempts: true,
      maxAttempts: true,
      customBuildId: true,
      type: true,
      customBuild: { select: { ownerId: true } },
    },
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
    await lockNotificationAccounts(tx, [job.customBuild.ownerId]);
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
    const buildFailed = await tx.customBuild.updateMany({
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
    if (buildFailed.count === 1) await enqueueGenerationNotification(tx, job.customBuildId);
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
