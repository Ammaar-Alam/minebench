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

async function runJob(job: CustomBuildJob, workerId: string, signal: AbortSignal): Promise<void> {
  throwIfCustomBuildLeaseLost(signal);
  if (job.type === "generate") {
    await runCustomBuildGenerateJob(job, {
      signal,
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
      throwIfCustomBuildLeaseLost(signal);
      await extendLeaseForSynchronousWork(job, workerId);
      throwIfCustomBuildLeaseLost(signal);
    },
  });
  throwIfCustomBuildLeaseLost(signal);
}

export async function runCustomBuildWorkerOnce(workerId = getCustomBuildWorkerId()): Promise<{
  processed: boolean;
  jobId?: string;
  jobType?: string;
}> {
  await recoverStaleCustomBuildJobLeases();
  const job = await claimNextCustomBuildJob(workerId);
  if (!job) return { processed: false };

  const leaseAbort = new AbortController();
  const heartbeat = startCustomBuildJobHeartbeat(job, workerId, leaseAbort);

  try {
    await runJob(job, workerId, leaseAbort.signal);
    throwIfCustomBuildLeaseLost(leaseAbort.signal);
    await completeCustomBuildJob(job.id, workerId);
    return { processed: true, jobId: job.id, jobType: job.type };
  } catch (error) {
    if (isCustomBuildLeaseLostError(error)) {
      console.warn(`custom build job ${job.id} stopped: ${redactSensitiveText(error)}`);
      return { processed: true, jobId: job.id, jobType: job.type };
    }
    const message = redactSensitiveText(error);
    const forceTerminal = job.type === "generate" && isTerminalCustomBuildGenerateError(message);
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

export async function runCustomBuildWorkerLoop(workerId = getCustomBuildWorkerId()): Promise<void> {
  let shutdownRequested = false;
  const stop = () => {
    shutdownRequested = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!shutdownRequested) {
    const result = await runCustomBuildWorkerOnce(workerId);
    if (!result.processed) {
      await sleep(getCustomBuildWorkerPollMs());
    }
  }

  await prisma.$disconnect();
}
