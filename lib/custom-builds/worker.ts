import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { CustomBuildJob } from "@prisma/client";
import {
  claimNextCustomBuildJob,
  completeCustomBuildJob,
  extendCustomBuildJobLease,
  failCustomBuildJob,
  getCustomBuildJobLeaseSeconds,
  recoverStaleCustomBuildJobLeases,
  renewCustomBuildJobLease,
} from "@/lib/custom-builds/jobs";
import { runCustomBuildExportJob } from "@/lib/custom-builds/exportJob";
import { isTerminalCustomBuildGenerateError, runCustomBuildGenerateJob } from "@/lib/custom-builds/generateJob";
import {
  CustomBuildLeaseLostError,
  isCustomBuildLeaseLostError,
  throwIfCustomBuildLeaseLost,
} from "@/lib/custom-builds/lease";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import { recordQueueHeartbeat, startActiveGenerationsHeartbeat } from "@/lib/observability/cloudwatch";
import { prisma } from "@/lib/prisma";

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const SYNCHRONOUS_EXPORT_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_CUSTOM_BUILD_WORKER_ID = `custom-worker-${hostname()}-${process.pid}-${randomUUID()}`;

export function getCustomBuildWorkerPollMs(): number {
  return readIntEnv("CUSTOM_BUILD_WORKER_POLL_MS", 2_000, 250, 60_000);
}

export function getCustomBuildWorkerConcurrency(): number {
  return readIntEnv("CUSTOM_BUILD_WORKER_CONCURRENCY", 10, 1, 20);
}

export function getCustomBuildWorkerId(): string {
  return process.env.CUSTOM_BUILD_WORKER_ID?.trim() || DEFAULT_CUSTOM_BUILD_WORKER_ID;
}

export function getCustomBuildWorkerHeartbeatMs(): number {
  const leaseMs = getCustomBuildJobLeaseSeconds() * 1000;
  return Math.max(1_000, Math.min(30_000, Math.floor(leaseMs / 2)));
}

export function getCustomBuildSynchronousExportLeaseMs(): number {
  return Math.max(getCustomBuildJobLeaseSeconds() * 1000, SYNCHRONOUS_EXPORT_LEASE_MS);
}

export function createCustomBuildProcessingGate(): {
  acquire: (signal?: AbortSignal) => Promise<() => void>;
} {
  let tail = Promise.resolve();

  return {
    async acquire(signal) {
      signal?.throwIfAborted();
      let unlock = () => {};
      const current = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const previous = tail;
      tail = previous.then(() => current);
      await previous;

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unlock();
      };
      try {
        signal?.throwIfAborted();
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}

function abortLease(controller: AbortController, message: string): void {
  if (controller.signal.aborted) return;
  controller.abort(new CustomBuildLeaseLostError(message));
}

function startCustomBuildJobHeartbeat(
  job: CustomBuildJob,
  workerId: string,
  controller: AbortController,
): NodeJS.Timeout {
  let renewalInFlight = false;
  return setInterval(() => {
    if (renewalInFlight || controller.signal.aborted) return;
    renewalInFlight = true;
    void renewCustomBuildJobLease(job.id, workerId)
      .then((renewed) => {
        if (!renewed) {
          abortLease(controller, "Custom build job lease is no longer owned by this worker.");
        }
      })
      .catch((error) => {
        abortLease(
          controller,
          `Custom build job lease renewal failed: ${redactSensitiveText(error)}`,
        );
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, getCustomBuildWorkerHeartbeatMs());
}

async function extendLeaseForSynchronousWork(job: CustomBuildJob, workerId: string): Promise<void> {
  let extended = false;
  try {
    extended = await extendCustomBuildJobLease(
      job.id,
      workerId,
      getCustomBuildSynchronousExportLeaseMs(),
    );
  } catch (error) {
    throw new CustomBuildLeaseLostError(
      `Custom build job lease extension failed: ${redactSensitiveText(error)}`,
    );
  }
  if (!extended) {
    throw new CustomBuildLeaseLostError("Custom build job lease is no longer owned by this worker.");
  }
}

async function runJob(
  job: CustomBuildJob,
  workerId: string,
  signal: AbortSignal,
  processingGate: ReturnType<typeof createCustomBuildProcessingGate>,
): Promise<void> {
  let releaseProcessing: (() => void) | undefined;
  const acquireProcessing = async () => {
    const release = await processingGate.acquire(signal);
    try {
      throwIfCustomBuildLeaseLost(signal);
      await extendLeaseForSynchronousWork(job, workerId);
      throwIfCustomBuildLeaseLost(signal);
      releaseProcessing = release;
      return release;
    } catch (error) {
      release();
      throw error;
    }
  };

  try {
    throwIfCustomBuildLeaseLost(signal);
    if (job.type === "generate") {
      await runCustomBuildGenerateJob(job, {
        signal,
        acquireBuildProcessing: acquireProcessing,
        beforeSynchronousArtifactPackaging: async () => {
          throwIfCustomBuildLeaseLost(signal);
          await extendLeaseForSynchronousWork(job, workerId);
          throwIfCustomBuildLeaseLost(signal);
        },
      });
      throwIfCustomBuildLeaseLost(signal);
      return;
    }
    await runCustomBuildExportJob(job, {
      signal,
      beforeSynchronousExport: async () => {
        await acquireProcessing();
      },
    });
    throwIfCustomBuildLeaseLost(signal);
  } finally {
    releaseProcessing?.();
  }
}

async function processClaimedJob(
  job: CustomBuildJob,
  workerId: string,
  processingGate: ReturnType<typeof createCustomBuildProcessingGate>,
): Promise<{
  processed: boolean;
  jobId?: string;
  jobType?: string;
}> {
  const leaseAbort = new AbortController();
  const heartbeat = startCustomBuildJobHeartbeat(job, workerId, leaseAbort);

  try {
    await runJob(job, workerId, leaseAbort.signal, processingGate);
    throwIfCustomBuildLeaseLost(leaseAbort.signal);
    await completeCustomBuildJob(job.id, workerId);
    return { processed: true, jobId: job.id, jobType: job.type };
  } catch (error) {
    if (isCustomBuildLeaseLostError(error)) {
      console.warn(`custom build job ${job.id} stopped: ${redactSensitiveText(error)}`);
      return { processed: true, jobId: job.id, jobType: job.type };
    }
    const message = redactSensitiveText(error);
    const forceTerminal = job.type === "generate" && isTerminalCustomBuildJobFailure(message);
    await failCustomBuildJob(job.id, workerId, {
      code: message === "provider_key_expired" ? "provider_key_expired" : "worker_failed",
      message,
    }, prisma, {
      forceTerminal,
    });
    return { processed: true, jobId: job.id, jobType: job.type };
  } finally {
    clearInterval(heartbeat);
  }
}

export function isTerminalCustomBuildJobFailure(message: string): boolean {
  return isTerminalCustomBuildGenerateError(message) || [
    "artifact_persistence_failed",
    "artifact_bookkeeping_failed",
    "generation_failed",
    "provider_rejected",
  ].includes(message);
}

export async function runCustomBuildWorkerOnce(workerId = getCustomBuildWorkerId()): Promise<{
  processed: boolean;
  jobId?: string;
  jobType?: string;
}> {
  await recoverStaleCustomBuildJobLeases();
  const job = await claimNextCustomBuildJob(workerId);
  if (!job) return { processed: false };
  return processClaimedJob(job, workerId, createCustomBuildProcessingGate());
}

async function checkAndReportQueueHealth(): Promise<void> {
  try {
    const oldest = await prisma.customBuildJob.findFirst({
      where: { status: "queued", runAfter: { lte: new Date() } },
      orderBy: { runAfter: "asc" },
      select: { runAfter: true },
    });
    const queuedCount = await prisma.customBuildJob.count({
      where: { status: "queued", runAfter: { lte: new Date() } },
    });
    const oldestAgeSeconds = oldest
      ? Math.max(0, (Date.now() - oldest.runAfter.getTime()) / 1000)
      : 0;
    recordQueueHeartbeat({ queuedCount, oldestAgeSeconds });
  } catch {
    // Non-blocking telemetry
  }
}

export async function runCustomBuildWorkerLoop(workerId = getCustomBuildWorkerId()): Promise<void> {
  let shutdownRequested = false;
  const concurrency = getCustomBuildWorkerConcurrency();
  const processingGate = createCustomBuildProcessingGate();
  const activeJobs = new Set<Promise<unknown>>();
  const heartbeat = startActiveGenerationsHeartbeat(
    () => activeJobs.size,
    () => !shutdownRequested,
    30_000,
    "worker",
  );
  void checkAndReportQueueHealth();
  const queueHeartbeat = setInterval(() => {
    void checkAndReportQueueHealth();
  }, 30_000);
  const stop = () => {
    shutdownRequested = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!shutdownRequested) {
      await recoverStaleCustomBuildJobLeases();
      let claimed = false;
      while (!shutdownRequested && activeJobs.size < concurrency) {
        const job = await claimNextCustomBuildJob(workerId);
        if (!job) break;
        claimed = true;
        const active = processClaimedJob(job, workerId, processingGate);
        activeJobs.add(active);
        void active.then(
          () => activeJobs.delete(active),
          () => activeJobs.delete(active),
        );
      }

      if (shutdownRequested) break;
      if (activeJobs.size >= concurrency) {
        await Promise.race(activeJobs);
      } else if (!claimed) {
        await Promise.race([sleep(getCustomBuildWorkerPollMs()), ...activeJobs]);
      }
    }

    await Promise.all(activeJobs);
  } finally {
    clearInterval(heartbeat);
    clearInterval(queueHeartbeat);
    await prisma.$disconnect();
  }
}
