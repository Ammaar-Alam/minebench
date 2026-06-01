import { setTimeout as sleep } from "node:timers/promises";
import type { CustomBuildJob } from "@prisma/client";
import {
  claimNextCustomBuildJob,
  completeCustomBuildJob,
  failCustomBuildJob,
  recoverStaleCustomBuildJobLeases,
  renewCustomBuildJobLease,
} from "@/lib/custom-builds/jobs";
import { runCustomBuildExportJob } from "@/lib/custom-builds/exportJob";
import { isTerminalCustomBuildGenerateError, runCustomBuildGenerateJob } from "@/lib/custom-builds/generateJob";
import { redactSensitiveText } from "@/lib/custom-builds/sanitize";
import { prisma } from "@/lib/prisma";

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function getCustomBuildWorkerPollMs(): number {
  return readIntEnv("CUSTOM_BUILD_WORKER_POLL_MS", 2_000, 250, 60_000);
}

export function getCustomBuildWorkerId(): string {
  return process.env.CUSTOM_BUILD_WORKER_ID?.trim() || `custom-worker-${process.pid}`;
}

async function runJob(job: CustomBuildJob): Promise<void> {
  if (job.type === "generate") {
    await runCustomBuildGenerateJob(job);
    return;
  }
  await runCustomBuildExportJob(job);
}

export async function runCustomBuildWorkerOnce(workerId = getCustomBuildWorkerId()): Promise<{
  processed: boolean;
  jobId?: string;
  jobType?: string;
}> {
  await recoverStaleCustomBuildJobLeases();
  const job = await claimNextCustomBuildJob(workerId);
  if (!job) return { processed: false };

  const heartbeat = setInterval(() => {
    void renewCustomBuildJobLease(job.id, workerId);
  }, 30_000);

  try {
    await runJob(job);
    await completeCustomBuildJob(job.id, workerId);
    return { processed: true, jobId: job.id, jobType: job.type };
  } catch (error) {
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
