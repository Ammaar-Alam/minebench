import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { ModelKey } from "../lib/ai/modelCatalog";
import { parseVoxelBuildSpec } from "../lib/voxel/validate";

export type BenchmarkMetricJob = {
  promptSlug: string;
  promptText?: string | null;
  modelKey: ModelKey;
  modelSlug: string;
  filePath: string;
};

export type BenchmarkRunConfiguration = {
  promptSha256: string;
  providerRoute: "direct" | "openrouter";
  reasoningOverride: string | null;
  requestConfiguration?: string;
  toolsEnabled: boolean;
};

export type BenchmarkSample = {
  inferenceTimeMs: number;
  jsonBytes: number;
  artifactSha256: string;
  attemptCount: number;
  acceptedOutputTokens?: number;
  configuration?: BenchmarkRunConfiguration;
};

type BenchmarkJobState = "running" | "finalizing" | "succeeded" | "failed" | "interrupted";

type BenchmarkJobRecord = {
  state: BenchmarkJobState;
  startedAt: string;
  endedAt?: string;
  retryCount: number;
  // Current invocation count used to reconcile retry and terminal states
  runAttemptCount?: number;
  // Response attempt numbers de-duplicate callbacks within the active invocation
  completedRunAttempts?: number[];
  rejectedRunAttempts?: number[];
  // Cumulative count retained across failed, interrupted, and resumed invocations
  totalAttemptCount?: number;
  // Completed responses exclude calls that fail before returning model output
  completedAttemptCount?: number;
  rejectedResponseCount?: number;
  error?: string;
  lastRunDurationMs?: number;
  failedAttemptCount?: number;
  failedRunCount?: number;
  interruptedRunCount?: number;
  ownerPid?: number;
  sample?: BenchmarkSample;
  pendingSample?: BenchmarkSample;
};

type BenchmarkLedger = {
  version: 1;
  jobs: Record<string, BenchmarkJobRecord>;
};

export type GeneratedModelBenchmarkMetrics = {
  expectedBuildCount: number;
  finalizedBuildCount: number;
  inferenceSampleCount: number;
  // Finalized cohort attempts replace the prior sample for a prompt
  finalizedAttemptSampleCount?: number;
  finalizedAttemptCount?: number;
  // Cumulative attempt coverage is tracked independently from finalized samples
  attemptTrackingJobCount?: number;
  totalAttemptCount?: number;
  completedAttemptTrackingJobCount?: number;
  completedAttemptCount?: number;
  rejectedResponseCount?: number;
  averageInferenceMs?: number;
  averageJsonSizeBytes?: number;
  outputCapTokens?: number;
  outputCapSampleCount?: number;
  outputCapIsConsistent?: boolean;
  configurationSampleCount?: number;
  configurationIsConsistent?: boolean;
  failedAttemptCount?: number;
  failedRunCount?: number;
  interruptedRunCount?: number;
};

type GeneratedBenchmarkMetrics = {
  version: 1;
  models: Partial<Record<ModelKey, GeneratedModelBenchmarkMetrics>>;
};

export type BenchmarkModelSummary = GeneratedModelBenchmarkMetrics & {
  failedCount: number;
  interruptedCount: number;
  runningCount: number;
};

function jobKey(job: Pick<BenchmarkMetricJob, "modelKey" | "promptSlug">): string {
  return `${job.modelKey}/${job.promptSlug}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function createBenchmarkRunConfiguration(args: {
  promptText: string;
  providerRoute: "direct" | "openrouter";
  reasoningOverride: string | null;
  requestConfiguration?: string;
  toolsEnabled: boolean;
}): BenchmarkRunConfiguration {
  return {
    promptSha256: sha256(args.promptText),
    providerRoute: args.providerRoute,
    reasoningOverride: args.reasoningOverride,
    ...(args.requestConfiguration
      ? { requestConfiguration: args.requestConfiguration }
      : {}),
    toolsEnabled: args.toolsEnabled,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isBenchmarkSample(value: unknown): value is BenchmarkSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Partial<BenchmarkSample>;
  return (
    isNonNegativeInteger(sample.inferenceTimeMs) &&
    isNonNegativeInteger(sample.jsonBytes) &&
    typeof sample.artifactSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(sample.artifactSha256) &&
    isPositiveInteger(sample.attemptCount) &&
    (sample.acceptedOutputTokens === undefined || isPositiveInteger(sample.acceptedOutputTokens)) &&
    (sample.configuration === undefined || isBenchmarkRunConfiguration(sample.configuration))
  );
}

function isBenchmarkRunConfiguration(value: unknown): value is BenchmarkRunConfiguration {
  if (!value || typeof value !== "object") return false;
  const configuration = value as Partial<BenchmarkRunConfiguration>;
  return (
    typeof configuration.promptSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(configuration.promptSha256) &&
    (configuration.providerRoute === "direct" || configuration.providerRoute === "openrouter") &&
    (configuration.reasoningOverride === null ||
      typeof configuration.reasoningOverride === "string") &&
    (configuration.requestConfiguration === undefined ||
      (typeof configuration.requestConfiguration === "string" &&
        configuration.requestConfiguration.length > 0)) &&
    typeof configuration.toolsEnabled === "boolean"
  );
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function atomicWriteText(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "w");
  try {
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function isMissingBenchmarkArtifact(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  const size = fs.statSync(filePath).size;
  if (size === 0) return true;
  if (size > Buffer.byteLength("{}\r\n")) return false;
  const text = fs.readFileSync(filePath, "utf8").trim();
  return !text || text === "{}";
}

function finalizedArtifact(filePath: string): { bytes: number } | null {
  if (isMissingBenchmarkArtifact(filePath)) return null;
  return { bytes: fs.statSync(filePath).size };
}

function verifiedArtifact(filePath: string): { bytes: number; hash: string } | null {
  if (!finalizedArtifact(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parseVoxelBuildSpec(parsed).ok) return null;
  } catch {
    return null;
  }
  return { bytes: Buffer.byteLength(text), hash: sha256(text) };
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function comparableConfigurationKey(configuration: BenchmarkRunConfiguration): string {
  return JSON.stringify({
    providerRoute: configuration.providerRoute,
    // Effective request settings prevent implicit and explicit defaults from splitting a cohort
    requestConfiguration:
      configuration.requestConfiguration ?? configuration.reasoningOverride,
    toolsEnabled: configuration.toolsEnabled,
  });
}

function incrementFailedAttemptCount(
  current: BenchmarkJobRecord | undefined,
  increment: number,
): number | undefined {
  if (increment <= 0) return current?.failedAttemptCount;
  if (!current) return increment;
  if (!isNonNegativeInteger(current.failedAttemptCount)) return undefined;
  return current.failedAttemptCount + increment;
}

function appendUniqueAttempt(attempts: number[] | undefined, attempt: number): number[] {
  const next = new Set(attempts ?? []);
  next.add(attempt);
  return Array.from(next).sort((a, b) => a - b);
}

function configurationMatchesJob(
  configuration: BenchmarkRunConfiguration | undefined,
  job: BenchmarkMetricJob,
): configuration is BenchmarkRunConfiguration {
  return (
    isBenchmarkRunConfiguration(configuration) &&
    typeof job.promptText === "string" &&
    configuration.promptSha256 === sha256(job.promptText)
  );
}

function processIsAlive(pid: number | undefined): boolean {
  if (!isPositiveInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class BenchmarkMetricsStore {
  readonly ledgerPath: string;
  readonly generatedMetricsPath: string;

  constructor(options?: { ledgerPath?: string; generatedMetricsPath?: string }) {
    this.ledgerPath =
      options?.ledgerPath ?? path.join(process.cwd(), "uploads", ".benchmark-metrics.json");
    this.generatedMetricsPath =
      options?.generatedMetricsPath ??
      path.join(process.cwd(), "lib", "ai", "modelBenchmarkMetrics.generated.json");
  }

  private readLedger(): BenchmarkLedger {
    const ledger = readJsonFile<BenchmarkLedger>(this.ledgerPath, { version: 1, jobs: {} });
    if (ledger.version !== 1 || !ledger.jobs || typeof ledger.jobs !== "object") {
      return { version: 1, jobs: {} };
    }
    return ledger;
  }

  private writeLedger(ledger: BenchmarkLedger): void {
    atomicWriteJson(this.ledgerPath, ledger);
  }

  private withLedgerLock<T>(operation: () => T): T {
    const lockPath = `${this.ledgerPath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    let descriptor: number | undefined;

    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        descriptor = fs.openSync(lockPath, "wx");
        fs.writeFileSync(descriptor, String(process.pid), "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const ownerPid = Number(fs.readFileSync(lockPath, "utf8"));
          if (isPositiveInteger(ownerPid) && !processIsAlive(ownerPid)) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
        }
        Atomics.wait(waitBuffer, 0, 0, 10);
      }
    }

    if (descriptor === undefined) {
      throw new Error(`Timed out waiting for benchmark metric ledger lock: ${lockPath}`);
    }

    try {
      return operation();
    } finally {
      fs.closeSync(descriptor);
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  getSample(job: BenchmarkMetricJob): BenchmarkSample | undefined {
    const sample = this.readLedger().jobs[jobKey(job)]?.sample;
    return isBenchmarkSample(sample) ? sample : undefined;
  }

  private updateRecord(
    job: BenchmarkMetricJob,
    update: (current: BenchmarkJobRecord | undefined) => BenchmarkJobRecord,
  ): BenchmarkJobRecord {
    return this.withLedgerLock(() => {
      const ledger = this.readLedger();
      const key = jobKey(job);
      const next = update(ledger.jobs[key]);
      ledger.jobs[key] = next;
      this.writeLedger(ledger);
      return next;
    });
  }

  markRunning(job: BenchmarkMetricJob, now = new Date()): void {
    this.updateRecord(job, (current) => {
      if (
        current &&
        (current.state === "running" || current.state === "finalizing") &&
        current.ownerPid !== process.pid &&
        processIsAlive(current.ownerPid)
      ) {
        throw new Error(`${job.promptSlug} × ${job.modelSlug} is already running in process ${current.ownerPid}.`);
      }
      return {
        state: "running",
        startedAt: now.toISOString(),
        retryCount: 0,
        runAttemptCount: 0,
        completedRunAttempts: [],
        rejectedRunAttempts: [],
        totalAttemptCount: current ? current.totalAttemptCount : 0,
        completedAttemptCount: current?.completedAttemptCount ?? 0,
        rejectedResponseCount: current?.rejectedResponseCount ?? 0,
        failedAttemptCount: current ? current.failedAttemptCount : 0,
        failedRunCount: current?.failedRunCount ?? 0,
        interruptedRunCount: current?.interruptedRunCount ?? 0,
        ownerPid: process.pid,
        sample: current?.sample,
      };
    });
  }

  markAttempt(job: BenchmarkMetricJob, attempt: number): void {
    this.updateRecord(job, (current) => {
      // onAttempt may repeat during callback recovery so only count a newly observed attempt
      const runAttemptCount = Math.max(current?.runAttemptCount ?? 0, attempt);
      const newlyStartedAttempts = runAttemptCount - (current?.runAttemptCount ?? 0);
      const totalAttemptCount =
        current?.totalAttemptCount === undefined
          ? current
            ? undefined
            : newlyStartedAttempts
          : current.totalAttemptCount + newlyStartedAttempts;
      return {
        ...current,
        state: current?.state ?? "running",
        startedAt: current?.startedAt ?? new Date().toISOString(),
        retryCount: current?.retryCount ?? 0,
        runAttemptCount,
        completedRunAttempts: current?.completedRunAttempts ?? [],
        rejectedRunAttempts: current?.rejectedRunAttempts ?? [],
        totalAttemptCount,
        completedAttemptCount: current?.completedAttemptCount ?? 0,
        rejectedResponseCount: current?.rejectedResponseCount ?? 0,
        failedAttemptCount: current ? current.failedAttemptCount : 0,
        failedRunCount: current?.failedRunCount ?? 0,
        interruptedRunCount: current?.interruptedRunCount ?? 0,
        ownerPid: current?.ownerPid ?? process.pid,
      };
    });
  }

  markCompletedAttempt(job: BenchmarkMetricJob, attempt: number): void {
    if (!isPositiveInteger(attempt)) {
      throw new Error(`Completed attempt must be a positive integer, received ${attempt}.`);
    }
    this.updateRecord(job, (current) => {
      const completedRunAttempts = appendUniqueAttempt(
        current?.completedRunAttempts,
        attempt,
      );
      const isNewCompletion =
        completedRunAttempts.length > (current?.completedRunAttempts?.length ?? 0);
      const completedAttemptCount =
        (current?.completedAttemptCount ?? 0) + Number(isNewCompletion);
      return {
        ...current,
        state: current?.state ?? "running",
        startedAt: current?.startedAt ?? new Date().toISOString(),
        retryCount: current?.retryCount ?? 0,
        runAttemptCount: current?.runAttemptCount,
        completedRunAttempts,
        rejectedRunAttempts: current?.rejectedRunAttempts ?? [],
        totalAttemptCount: current?.totalAttemptCount,
        completedAttemptCount,
        rejectedResponseCount: current?.rejectedResponseCount ?? 0,
        failedAttemptCount: current ? current.failedAttemptCount : 0,
        failedRunCount: current?.failedRunCount ?? 0,
        interruptedRunCount: current?.interruptedRunCount ?? 0,
        ownerPid: current?.ownerPid ?? process.pid,
      };
    });
  }

  markRetry(job: BenchmarkMetricJob, attempt: number): void {
    this.updateRecord(job, (current) => {
      const retryCount = Math.max(current?.retryCount ?? 0, attempt - 1);
      // Starting attempt N confirms attempts before N failed
      const newlyFailedAttempts = retryCount - (current?.retryCount ?? 0);
      const rejectedAttempt = attempt - 1;
      const completedRunAttempts = current?.completedRunAttempts ?? [];
      const rejectedRunAttempts = completedRunAttempts.includes(rejectedAttempt)
        ? appendUniqueAttempt(current?.rejectedRunAttempts, rejectedAttempt)
        : current?.rejectedRunAttempts ?? [];
      const newlyRejectedResponses =
        rejectedRunAttempts.length - (current?.rejectedRunAttempts?.length ?? 0);
      const rejectedResponseCount =
        (current?.rejectedResponseCount ?? 0) + newlyRejectedResponses;
      return {
        ...current,
        state: current?.state ?? "running",
        startedAt: current?.startedAt ?? new Date().toISOString(),
        retryCount,
        runAttemptCount: current?.runAttemptCount,
        completedRunAttempts,
        rejectedRunAttempts,
        totalAttemptCount: current?.totalAttemptCount,
        completedAttemptCount: current?.completedAttemptCount,
        rejectedResponseCount,
        failedAttemptCount: incrementFailedAttemptCount(current, newlyFailedAttempts),
        failedRunCount: current?.failedRunCount ?? 0,
        interruptedRunCount: current?.interruptedRunCount ?? 0,
        ownerPid: current?.ownerPid ?? process.pid,
      };
    });
  }

  markFailed(
    job: BenchmarkMetricJob,
    error: string,
    durationMs?: number,
    now = new Date(),
  ): void {
    this.updateRecord(job, (current) => {
      const newlyFailedRuns = current?.state === "failed" ? 0 : 1;
      // Only a started terminal attempt counts as a failed attempt
      const newlyFailedAttempts =
        newlyFailedRuns > 0 &&
        (current?.runAttemptCount ?? 0) > (current?.retryCount ?? 0)
          ? 1
          : 0;
      const failedRunCount =
        (current?.failedRunCount ?? 0) + newlyFailedRuns;
      const terminalAttempt = current?.runAttemptCount ?? 0;
      const completedRunAttempts = current?.completedRunAttempts ?? [];
      const rejectedRunAttempts =
        newlyFailedRuns > 0 && completedRunAttempts.includes(terminalAttempt)
          ? appendUniqueAttempt(current?.rejectedRunAttempts, terminalAttempt)
          : current?.rejectedRunAttempts ?? [];
      const newlyRejectedResponses =
        rejectedRunAttempts.length - (current?.rejectedRunAttempts?.length ?? 0);
      const rejectedResponseCount =
        (current?.rejectedResponseCount ?? 0) + newlyRejectedResponses;
      return {
        state: "failed",
        startedAt: current?.startedAt ?? now.toISOString(),
        endedAt: now.toISOString(),
        retryCount: current?.retryCount ?? 0,
        runAttemptCount: current?.runAttemptCount,
        completedRunAttempts,
        rejectedRunAttempts,
        totalAttemptCount: current?.totalAttemptCount,
        completedAttemptCount: current?.completedAttemptCount,
        rejectedResponseCount,
        error,
        lastRunDurationMs: isNonNegativeInteger(durationMs) ? durationMs : undefined,
        failedAttemptCount: incrementFailedAttemptCount(current, newlyFailedAttempts),
        failedRunCount,
        interruptedRunCount: current?.interruptedRunCount ?? 0,
        sample: current?.sample,
      };
    });
  }

  markInterrupted(job: BenchmarkMetricJob, reason: string, now = new Date()): void {
    this.updateRecord(job, (current) => {
      if (
        current &&
        current.state !== "running" &&
        current.state !== "finalizing"
      ) {
        return current;
      }
      const startedAt = current?.startedAt ?? now.toISOString();
      const elapsed = Math.max(0, now.getTime() - Date.parse(startedAt));
      return {
        state: "interrupted",
        startedAt,
        endedAt: now.toISOString(),
        retryCount: current?.retryCount ?? 0,
        runAttemptCount: current?.runAttemptCount,
        completedRunAttempts: current?.completedRunAttempts,
        rejectedRunAttempts: current?.rejectedRunAttempts,
        totalAttemptCount: current?.totalAttemptCount,
        completedAttemptCount: current?.completedAttemptCount,
        rejectedResponseCount: current?.rejectedResponseCount,
        error: reason,
        lastRunDurationMs: Number.isFinite(elapsed) ? Math.round(elapsed) : undefined,
        failedAttemptCount: current?.failedAttemptCount,
        failedRunCount: current?.failedRunCount ?? 0,
        interruptedRunCount:
          (current?.interruptedRunCount ?? 0) +
          (current?.state === "interrupted" ? 0 : 1),
        sample: current?.sample,
      };
    });
  }

  finalizeSuccess(
    job: BenchmarkMetricJob,
    serializedBuild: string,
    details: {
      inferenceTimeMs: number;
      attemptCount: number;
      acceptedOutputTokens?: number;
      configuration?: BenchmarkRunConfiguration;
    },
    now = new Date(),
  ): BenchmarkSample {
    const sample: BenchmarkSample = {
      inferenceTimeMs: Math.max(0, Math.round(details.inferenceTimeMs)),
      jsonBytes: Buffer.byteLength(serializedBuild),
      artifactSha256: sha256(serializedBuild),
      attemptCount: Math.max(1, Math.round(details.attemptCount)),
      ...(isPositiveInteger(details.acceptedOutputTokens)
        ? { acceptedOutputTokens: details.acceptedOutputTokens }
        : {}),
      ...(isBenchmarkRunConfiguration(details.configuration)
        ? { configuration: details.configuration }
        : {}),
    };

    // A finalized build always has one completed provider response
    this.markCompletedAttempt(job, sample.attemptCount);
    this.updateRecord(job, (current) => {
      const retryCount = Math.max(0, sample.attemptCount - 1);
      const missingFailedAttempts = Math.max(
        0,
        retryCount - (current?.retryCount ?? 0),
      );
      const missingStartedAttempts = Math.max(
        0,
        sample.attemptCount - (current?.runAttemptCount ?? 0),
      );
      const totalAttemptCount =
        current?.totalAttemptCount === undefined
          ? current
            ? undefined
            : missingStartedAttempts
          : current.totalAttemptCount + missingStartedAttempts;
      return {
        state: "finalizing",
        startedAt: current?.startedAt ?? now.toISOString(),
        retryCount,
        runAttemptCount: sample.attemptCount,
        completedRunAttempts: current?.completedRunAttempts,
        rejectedRunAttempts: current?.rejectedRunAttempts,
        totalAttemptCount,
        completedAttemptCount: current?.completedAttemptCount,
        rejectedResponseCount: current?.rejectedResponseCount,
        failedAttemptCount: incrementFailedAttemptCount(
          current,
          missingFailedAttempts,
        ),
        failedRunCount: current?.failedRunCount ?? 0,
        interruptedRunCount: current?.interruptedRunCount ?? 0,
        ownerPid: process.pid,
        sample: current?.sample,
        pendingSample: sample,
      };
    });
    atomicWriteText(job.filePath, serializedBuild);
    this.updateRecord(job, (current) => ({
      state: "succeeded",
      startedAt: current?.startedAt ?? now.toISOString(),
      endedAt: now.toISOString(),
      retryCount: Math.max(0, sample.attemptCount - 1),
      runAttemptCount: current?.runAttemptCount,
      completedRunAttempts: current?.completedRunAttempts,
      rejectedRunAttempts: current?.rejectedRunAttempts,
      totalAttemptCount: current?.totalAttemptCount,
      completedAttemptCount: current?.completedAttemptCount,
      rejectedResponseCount: current?.rejectedResponseCount,
      failedAttemptCount: current?.failedAttemptCount,
      failedRunCount: current?.failedRunCount ?? 0,
      interruptedRunCount: current?.interruptedRunCount ?? 0,
      sample,
    }));
    return sample;
  }

  reconcile(jobs: BenchmarkMetricJob[], now = new Date()): string[] {
    return this.withLedgerLock(() => {
      const ledger = this.readLedger();
      const warnings: string[] = [];
      let changed = false;

      for (const job of jobs) {
        const key = jobKey(job);
        const current = ledger.jobs[key];
        if (!current) continue;

        if (
          (current.state === "running" || current.state === "finalizing") &&
          current.ownerPid !== process.pid &&
          processIsAlive(current.ownerPid)
        ) {
          warnings.push(
            `${job.promptSlug} × ${job.modelSlug}: active in process ${current.ownerPid}; lifecycle state was left unchanged.`,
          );
          continue;
        }

        if (current.state === "running") {
          ledger.jobs[key] = {
            ...current,
            state: "interrupted",
            endedAt: now.toISOString(),
            error: "Previous process ended before this job finalized.",
            lastRunDurationMs: Math.max(0, now.getTime() - Date.parse(current.startedAt)),
            interruptedRunCount: (current.interruptedRunCount ?? 0) + 1,
            ownerPid: undefined,
          };
          changed = true;
          continue;
        }

        if (current.state === "finalizing" && isBenchmarkSample(current.pendingSample)) {
          const artifact = verifiedArtifact(job.filePath);
          if (artifact?.hash === current.pendingSample.artifactSha256) {
            ledger.jobs[key] = {
              state: "succeeded",
              startedAt: current.startedAt,
              endedAt: now.toISOString(),
              retryCount: current.retryCount,
              runAttemptCount: current.runAttemptCount,
              completedRunAttempts: current.completedRunAttempts,
              rejectedRunAttempts: current.rejectedRunAttempts,
              totalAttemptCount: current.totalAttemptCount,
              completedAttemptCount: current.completedAttemptCount,
              rejectedResponseCount: current.rejectedResponseCount,
              failedAttemptCount: current.failedAttemptCount,
              failedRunCount: current.failedRunCount ?? 0,
              interruptedRunCount: current.interruptedRunCount ?? 0,
              sample: current.pendingSample,
            };
          } else {
            ledger.jobs[key] = {
              state: "interrupted",
              startedAt: current.startedAt,
              endedAt: now.toISOString(),
              retryCount: current.retryCount,
              runAttemptCount: current.runAttemptCount,
              completedRunAttempts: current.completedRunAttempts,
              rejectedRunAttempts: current.rejectedRunAttempts,
              totalAttemptCount: current.totalAttemptCount,
              completedAttemptCount: current.completedAttemptCount,
              rejectedResponseCount: current.rejectedResponseCount,
              error: "Final artifact did not match the pending benchmark sample.",
              failedAttemptCount: current.failedAttemptCount,
              failedRunCount: current.failedRunCount ?? 0,
              interruptedRunCount: (current.interruptedRunCount ?? 0) + 1,
              sample: current.sample,
            };
          }
          changed = true;
          continue;
        }

        if (!isBenchmarkSample(current.sample)) continue;
        const artifact = verifiedArtifact(job.filePath);
        if (!artifact) {
          warnings.push(`${job.promptSlug} × ${job.modelSlug}: final JSON is missing or invalid.`);
          continue;
        }
        if (
          artifact.hash !== current.sample.artifactSha256 ||
          artifact.bytes !== current.sample.jsonBytes
        ) {
          ledger.jobs[key] = {
            ...current,
            sample: {
              ...current.sample,
              jsonBytes: artifact.bytes,
              artifactSha256: artifact.hash,
            },
          };
          changed = true;
        }
      }

      if (changed) this.writeLedger(ledger);
      return warnings;
    });
  }

  refreshGeneratedMetrics(jobs: BenchmarkMetricJob[]): GeneratedBenchmarkMetrics {
    const ledger = this.readLedger();
    const persisted = readJsonFile<GeneratedBenchmarkMetrics>(
      this.generatedMetricsPath,
      { version: 1, models: {} },
    );
    const computed: GeneratedBenchmarkMetrics = {
      version: 1,
      models: { ...persisted.models },
    };
    let persistedChanged = false;
    const jobsByModel = new Map<ModelKey, BenchmarkMetricJob[]>();
    for (const job of jobs) {
      const group = jobsByModel.get(job.modelKey) ?? [];
      group.push(job);
      jobsByModel.set(job.modelKey, group);
    }

    for (const [modelKey, modelJobs] of jobsByModel) {
      const uniqueJobs = Array.from(
        new Map(modelJobs.map((job) => [job.promptSlug, job])).values(),
      );
      const artifacts = uniqueJobs.map((job) => ({
        job,
        artifact: verifiedArtifact(job.filePath),
      }));
      const finalized = artifacts.filter(({ artifact }) => artifact !== null);
      const timingSamples: BenchmarkSample[] = [];
      const configuredSamples: BenchmarkSample[] = [];
      const outputCaps: number[] = [];
      const records = uniqueJobs.map((job) => ledger.jobs[jobKey(job)]);

      for (const { job, artifact } of artifacts) {
        if (!artifact) continue;
        const sample = ledger.jobs[jobKey(job)]?.sample;
        if (!isBenchmarkSample(sample)) continue;
        if (!("hash" in artifact) || sample.artifactSha256 !== artifact.hash) continue;
        timingSamples.push(sample);
        if (!configurationMatchesJob(sample.configuration, job)) continue;
        configuredSamples.push(sample);
        if (sample.acceptedOutputTokens !== undefined) outputCaps.push(sample.acceptedOutputTokens);
      }

      const expectedBuildCount = uniqueJobs.length;
      const finalizedBuildCount = finalized.length;
      const completeArtifacts = finalizedBuildCount === expectedBuildCount && expectedBuildCount > 0;
      const completeConfigurations =
        configuredSamples.length === expectedBuildCount && expectedBuildCount > 0;
      const configurationKeys = new Set(
        configuredSamples.map((sample) => comparableConfigurationKey(sample.configuration!)),
      );
      const uniqueOutputCaps = new Set(outputCaps);
      const outputCapIsConsistent =
        outputCaps.length === expectedBuildCount &&
        expectedBuildCount > 0 &&
        uniqueOutputCaps.size === 1;
      const configurationIsConsistent =
        completeConfigurations &&
        configurationKeys.size === 1 &&
        outputCapIsConsistent;
      const attemptTrackingJobCount = records.filter((record) =>
        isNonNegativeInteger(record?.totalAttemptCount),
      ).length;
      const attemptTrackingIsComplete =
        records.length === expectedBuildCount &&
        attemptTrackingJobCount === expectedBuildCount;
      const completedAttemptTrackingJobCount = records.filter((record) =>
        isNonNegativeInteger(record?.completedAttemptCount),
      ).length;
      const completedAttemptTrackingIsComplete =
        records.length === expectedBuildCount &&
        completedAttemptTrackingJobCount === expectedBuildCount;
      const rejectedResponseTrackingIsComplete =
        records.length === expectedBuildCount &&
        records.every((record) => isNonNegativeInteger(record?.rejectedResponseCount));
      const failedAttemptTrackingIsComplete =
        records.length === expectedBuildCount &&
        records.every((record) => isNonNegativeInteger(record?.failedAttemptCount));
      const failedRunTrackingIsComplete =
        records.length === expectedBuildCount &&
        records.every((record) => isNonNegativeInteger(record?.failedRunCount));
      const interruptedRunTrackingIsComplete =
        records.length === expectedBuildCount &&
        records.every((record) => isNonNegativeInteger(record?.interruptedRunCount));
      const metrics: GeneratedModelBenchmarkMetrics = {
        expectedBuildCount,
        finalizedBuildCount,
        inferenceSampleCount: timingSamples.length,
        finalizedAttemptSampleCount: configuredSamples.length,
        attemptTrackingJobCount,
        completedAttemptTrackingJobCount,
        configurationSampleCount: configuredSamples.length,
        configurationIsConsistent,
        outputCapSampleCount: outputCaps.length,
        outputCapIsConsistent,
        ...(completeArtifacts
          ? { averageJsonSizeBytes: average(finalized.map(({ artifact }) => artifact!.bytes)) }
          : {}),
        ...(configurationIsConsistent
          ? {
              averageInferenceMs: average(
                configuredSamples.map((sample) => sample.inferenceTimeMs),
              ),
              // Finalized cohort count remains useful when auditing accepted artifacts
              finalizedAttemptCount: configuredSamples.reduce(
                (sum, sample) => sum + sample.attemptCount,
                0,
              ),
            }
          : {}),
        ...(outputCapIsConsistent
          ? { outputCapTokens: outputCaps[0] }
          : {}),
        ...(attemptTrackingIsComplete
          ? {
              // Includes every provider call, even calls that never returned model output
              totalAttemptCount: records.reduce(
                (sum, record) => sum + record!.totalAttemptCount!,
                0,
              ),
            }
          : {}),
        ...(completedAttemptTrackingIsComplete
          ? {
              // Public attempts include accepted and rejected completed responses
              completedAttemptCount: records.reduce(
                (sum, record) => sum + record!.completedAttemptCount!,
                0,
              ),
            }
          : {}),
        ...(rejectedResponseTrackingIsComplete
          ? {
              rejectedResponseCount: records.reduce(
                (sum, record) => sum + record!.rejectedResponseCount!,
                0,
              ),
            }
          : {}),
        ...(failedAttemptTrackingIsComplete
          ? {
              failedAttemptCount: records.reduce(
                (sum, record) => sum + record!.failedAttemptCount!,
                0,
              ),
            }
          : {}),
        ...(failedRunTrackingIsComplete
          ? {
              failedRunCount: records.reduce(
                (sum, record) => sum + record!.failedRunCount!,
                0,
              ),
            }
          : {}),
        ...(interruptedRunTrackingIsComplete
          ? {
              interruptedRunCount: records.reduce(
                (sum, record) => sum + record!.interruptedRunCount!,
                0,
              ),
            }
          : {}),
      };
      computed.models[modelKey] = metrics;

      if (!completeArtifacts) continue;

      const previous = persisted.models[modelKey];
      const completeTimingCohort =
        timingSamples.length === expectedBuildCount && expectedBuildCount > 0;
      const next: GeneratedModelBenchmarkMetrics = {
        expectedBuildCount,
        finalizedBuildCount,
        inferenceSampleCount: previous?.inferenceSampleCount ?? metrics.inferenceSampleCount,
        ...(previous?.finalizedAttemptSampleCount === undefined
          ? {}
          : { finalizedAttemptSampleCount: previous.finalizedAttemptSampleCount }),
        ...(previous?.finalizedAttemptCount === undefined
          ? {}
          : { finalizedAttemptCount: previous.finalizedAttemptCount }),
        ...(previous?.attemptTrackingJobCount === undefined
          ? {}
          : { attemptTrackingJobCount: previous.attemptTrackingJobCount }),
        ...(previous?.totalAttemptCount === undefined
          ? {}
          : { totalAttemptCount: previous.totalAttemptCount }),
        ...(previous?.completedAttemptTrackingJobCount === undefined
          ? {}
          : {
              completedAttemptTrackingJobCount:
                previous.completedAttemptTrackingJobCount,
            }),
        ...(previous?.completedAttemptCount === undefined
          ? {}
          : { completedAttemptCount: previous.completedAttemptCount }),
        ...(previous?.rejectedResponseCount === undefined
          ? {}
          : { rejectedResponseCount: previous.rejectedResponseCount }),
        configurationSampleCount:
          previous?.configurationSampleCount ?? metrics.configurationSampleCount,
        configurationIsConsistent:
          previous?.configurationIsConsistent ?? metrics.configurationIsConsistent,
        outputCapSampleCount:
          previous?.outputCapSampleCount ?? metrics.outputCapSampleCount,
        outputCapIsConsistent:
          previous?.outputCapIsConsistent ?? metrics.outputCapIsConsistent,
        averageJsonSizeBytes: metrics.averageJsonSizeBytes,
        ...(previous?.averageInferenceMs === undefined
          ? {}
          : { averageInferenceMs: previous.averageInferenceMs }),
        ...(previous?.outputCapTokens === undefined
          ? {}
          : { outputCapTokens: previous.outputCapTokens }),
        ...(previous?.failedAttemptCount === undefined
          ? {}
          : { failedAttemptCount: previous.failedAttemptCount }),
        ...(previous?.failedRunCount === undefined
          ? {}
          : { failedRunCount: previous.failedRunCount }),
        ...(previous?.interruptedRunCount === undefined
          ? {}
          : { interruptedRunCount: previous.interruptedRunCount }),
      };

      if (completeTimingCohort) {
        next.inferenceSampleCount = metrics.inferenceSampleCount;
        next.finalizedAttemptSampleCount = metrics.finalizedAttemptSampleCount;
        next.configurationSampleCount = metrics.configurationSampleCount;
        next.configurationIsConsistent = metrics.configurationIsConsistent;
        next.outputCapSampleCount = metrics.outputCapSampleCount;
        next.outputCapIsConsistent = metrics.outputCapIsConsistent;
        if (metrics.averageInferenceMs === undefined) delete next.averageInferenceMs;
        else next.averageInferenceMs = metrics.averageInferenceMs;
        if (metrics.finalizedAttemptCount === undefined) delete next.finalizedAttemptCount;
        else next.finalizedAttemptCount = metrics.finalizedAttemptCount;
        if (metrics.outputCapTokens === undefined) delete next.outputCapTokens;
        else next.outputCapTokens = metrics.outputCapTokens;
      }
      if (metrics.totalAttemptCount !== undefined) {
        next.attemptTrackingJobCount = metrics.attemptTrackingJobCount;
        next.totalAttemptCount = metrics.totalAttemptCount;
      }
      if (metrics.completedAttemptCount !== undefined) {
        next.completedAttemptTrackingJobCount =
          metrics.completedAttemptTrackingJobCount;
        next.completedAttemptCount = metrics.completedAttemptCount;
      }
      if (metrics.rejectedResponseCount !== undefined) {
        next.rejectedResponseCount = metrics.rejectedResponseCount;
      }
      if (metrics.failedAttemptCount !== undefined) {
        next.failedAttemptCount = metrics.failedAttemptCount;
      }
      if (metrics.failedRunCount !== undefined) {
        next.failedRunCount = metrics.failedRunCount;
      }
      if (metrics.interruptedRunCount !== undefined) {
        next.interruptedRunCount = metrics.interruptedRunCount;
      }

      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        persisted.models[modelKey] = next;
        persistedChanged = true;
      }
    }

    if (persistedChanged) atomicWriteJson(this.generatedMetricsPath, persisted);
    return computed;
  }

  summarize(jobs: BenchmarkMetricJob[]): Map<ModelKey, BenchmarkModelSummary> {
    const generated = this.refreshGeneratedMetrics(jobs);
    const ledger = this.readLedger();
    const summaries = new Map<ModelKey, BenchmarkModelSummary>();

    for (const job of jobs) {
      if (summaries.has(job.modelKey)) continue;
      const metrics = generated.models[job.modelKey];
      if (!metrics) continue;
      const modelJobs = jobs.filter((candidate) => candidate.modelKey === job.modelKey);
      const records = modelJobs.map((candidate) => ledger.jobs[jobKey(candidate)]);
      summaries.set(job.modelKey, {
        ...metrics,
        failedCount: records.reduce((sum, record) => sum + (record?.failedRunCount ?? 0), 0),
        interruptedCount: records.reduce(
          (sum, record) => sum + (record?.interruptedRunCount ?? 0),
          0,
        ),
        runningCount: records.filter(
          (record) => record?.state === "running" || record?.state === "finalizing",
        ).length,
      });
    }

    return summaries;
  }
}
