import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { ModelKey } from "../lib/ai/modelCatalog";

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
  error?: string;
  lastRunDurationMs?: number;
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
  averageInferenceMs?: number;
  averageJsonSizeBytes?: number;
  outputCapTokens?: number;
  configurationSampleCount?: number;
  configurationIsConsistent?: boolean;
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
  toolsEnabled: boolean;
}): BenchmarkRunConfiguration {
  return {
    promptSha256: sha256(args.promptText),
    providerRoute: args.providerRoute,
    reasoningOverride: args.reasoningOverride,
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
    JSON.parse(text);
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
    reasoningOverride: configuration.reasoningOverride,
    toolsEnabled: configuration.toolsEnabled,
  });
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
        failedRunCount: current?.failedRunCount ?? 0,
        interruptedRunCount: current?.interruptedRunCount ?? 0,
        ownerPid: process.pid,
        sample: current?.sample,
      };
    });
  }

  markRetry(job: BenchmarkMetricJob, attempt: number): void {
    this.updateRecord(job, (current) => ({
      ...current,
      state: current?.state ?? "running",
      startedAt: current?.startedAt ?? new Date().toISOString(),
      retryCount: Math.max(current?.retryCount ?? 0, attempt - 1),
      failedRunCount: current?.failedRunCount ?? 0,
      interruptedRunCount: current?.interruptedRunCount ?? 0,
      ownerPid: current?.ownerPid ?? process.pid,
    }));
  }

  markFailed(
    job: BenchmarkMetricJob,
    error: string,
    durationMs?: number,
    now = new Date(),
  ): void {
    this.updateRecord(job, (current) => {
      const failedRunCount =
        (current?.failedRunCount ?? 0) + (current?.state === "failed" ? 0 : 1);
      return {
        state: "failed",
        startedAt: current?.startedAt ?? now.toISOString(),
        endedAt: now.toISOString(),
        retryCount: current?.retryCount ?? 0,
        error,
        lastRunDurationMs: isNonNegativeInteger(durationMs) ? durationMs : undefined,
        failedRunCount,
        interruptedRunCount: current?.interruptedRunCount ?? 0,
        sample: current?.sample,
      };
    });
  }

  markInterrupted(job: BenchmarkMetricJob, reason: string, now = new Date()): void {
    this.updateRecord(job, (current) => {
      const startedAt = current?.startedAt ?? now.toISOString();
      const elapsed = Math.max(0, now.getTime() - Date.parse(startedAt));
      return {
        state: "interrupted",
        startedAt,
        endedAt: now.toISOString(),
        retryCount: current?.retryCount ?? 0,
        error: reason,
        lastRunDurationMs: Number.isFinite(elapsed) ? Math.round(elapsed) : undefined,
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

    this.updateRecord(job, (current) => ({
      state: "finalizing",
      startedAt: current?.startedAt ?? now.toISOString(),
      retryCount: current?.retryCount ?? Math.max(0, sample.attemptCount - 1),
      failedRunCount: current?.failedRunCount ?? 0,
      interruptedRunCount: current?.interruptedRunCount ?? 0,
      ownerPid: process.pid,
      sample: current?.sample,
      pendingSample: sample,
    }));
    atomicWriteText(job.filePath, serializedBuild);
    this.updateRecord(job, (current) => ({
      state: "succeeded",
      startedAt: current?.startedAt ?? now.toISOString(),
      endedAt: now.toISOString(),
      retryCount: Math.max(0, sample.attemptCount - 1),
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
              error: "Final artifact did not match the pending benchmark sample.",
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
      const artifacts = uniqueJobs.map((job) => {
        const sample = ledger.jobs[jobKey(job)]?.sample;
        return {
          job,
          artifact: isBenchmarkSample(sample)
            ? verifiedArtifact(job.filePath)
            : finalizedArtifact(job.filePath),
        };
      });
      const finalized = artifacts.filter(({ artifact }) => artifact !== null);
      const timingSamples: BenchmarkSample[] = [];
      const configuredSamples: BenchmarkSample[] = [];
      const outputCaps: number[] = [];

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
      const configurationIsConsistent =
        completeConfigurations &&
        configurationKeys.size === 1 &&
        outputCaps.length === expectedBuildCount &&
        uniqueOutputCaps.size === 1;
      const metrics: GeneratedModelBenchmarkMetrics = {
        expectedBuildCount,
        finalizedBuildCount,
        inferenceSampleCount: timingSamples.length,
        configurationSampleCount: configuredSamples.length,
        configurationIsConsistent,
        ...(completeArtifacts
          ? { averageJsonSizeBytes: average(finalized.map(({ artifact }) => artifact!.bytes)) }
          : {}),
        ...(configurationIsConsistent
          ? {
              averageInferenceMs: average(
                configuredSamples.map((sample) => sample.inferenceTimeMs),
              ),
            }
          : {}),
        ...(configurationIsConsistent
          ? { outputCapTokens: outputCaps[0] }
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
        configurationSampleCount:
          previous?.configurationSampleCount ?? metrics.configurationSampleCount,
        configurationIsConsistent:
          previous?.configurationIsConsistent ?? metrics.configurationIsConsistent,
        averageJsonSizeBytes: metrics.averageJsonSizeBytes,
        ...(previous?.averageInferenceMs === undefined
          ? {}
          : { averageInferenceMs: previous.averageInferenceMs }),
        ...(previous?.outputCapTokens === undefined
          ? {}
          : { outputCapTokens: previous.outputCapTokens }),
      };

      if (completeTimingCohort) {
        next.inferenceSampleCount = metrics.inferenceSampleCount;
        next.configurationSampleCount = metrics.configurationSampleCount;
        next.configurationIsConsistent = metrics.configurationIsConsistent;
        if (metrics.averageInferenceMs === undefined) delete next.averageInferenceMs;
        else next.averageInferenceMs = metrics.averageInferenceMs;
        if (metrics.outputCapTokens === undefined) delete next.outputCapTokens;
        else next.outputCapTokens = metrics.outputCapTokens;
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
