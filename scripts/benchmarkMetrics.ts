import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { GeneratedModelBenchmarkMetrics } from "../lib/ai/modelBenchmarkProfiles";
import type { ModelKey } from "../lib/ai/modelCatalog";
import { BENCHMARK_PROMPT_MAP, promptCohortId } from "../lib/benchmark/prompts";
import { parseVoxelBuildSpec } from "../lib/voxel/validate";

export type { GeneratedModelBenchmarkMetrics };

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
  // Versioned only when the provider reports the settings it accepted
  requestConfigurationVersion?: 1;
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

// Counters accumulating across every invocation of a job, including runs that
// failed, were interrupted, or resumed later
// Undefined means the job predates that counter, which keeps a partially tracked
// cohort from reporting a total that undercounts real history
type BenchmarkJobCounters = {
  // Provider calls issued, including calls that never returned model output
  providerCallCount?: number;
  // Responses the provider returned, whether later accepted or rejected
  completedAttemptCount?: number;
  // Returned responses that failed extraction, validation, or execution
  rejectedResponseCount?: number;
  // Attempts that ended without a usable response, including terminal failures
  failedAttemptCount?: number;
  failedRunCount?: number;
  interruptedRunCount?: number;
};

type BenchmarkJobRecord = BenchmarkJobCounters & {
  state: BenchmarkJobState;
  startedAt: string;
  endedAt?: string;
  retryCount: number;
  // Highest attempt started by the active invocation, used to reconcile retry
  // and terminal states against the cumulative counters
  runAttemptCount?: number;
  // Attempt numbers seen this invocation, so a repeated callback does not
  // double-count a response
  completedRunAttempts?: number[];
  rejectedRunAttempts?: number[];
  error?: string;
  lastRunDurationMs?: number;
  ownerPid?: number;
  sample?: BenchmarkSample;
  pendingSample?: BenchmarkSample;
  generatedMetricsDirty?: boolean;
};

// Counters that a fresh job starts at zero, keyed for table-driven carry-over
const ZEROED_COUNTERS = [
  "providerCallCount",
  "completedAttemptCount",
  "rejectedResponseCount",
  "failedAttemptCount",
  "failedRunCount",
  "interruptedRunCount",
] as const satisfies readonly (keyof BenchmarkJobCounters)[];

// Carries every cumulative counter forward untouched
// Transitions spread this and override only what they change, so a new counter
// needs one field here instead of an edit in every mark method
function carriedCounters(current: BenchmarkJobRecord | undefined): BenchmarkJobCounters {
  return {
    providerCallCount: current?.providerCallCount,
    completedAttemptCount: current?.completedAttemptCount,
    rejectedResponseCount: current?.rejectedResponseCount,
    failedAttemptCount: current?.failedAttemptCount,
    failedRunCount: current?.failedRunCount ?? 0,
    interruptedRunCount: current?.interruptedRunCount ?? 0,
  };
}

// Fields carried across lifecycle transitions
function carriedRunState(
  current: BenchmarkJobRecord | undefined,
): Pick<
  BenchmarkJobRecord,
  "runAttemptCount" | "completedRunAttempts" | "rejectedRunAttempts" | "generatedMetricsDirty"
> {
  return {
    runAttemptCount: current?.runAttemptCount,
    completedRunAttempts: current?.completedRunAttempts,
    rejectedRunAttempts: current?.rejectedRunAttempts,
    generatedMetricsDirty: current?.generatedMetricsDirty,
  };
}

type BenchmarkLedger = {
  version: 2;
  jobs: Record<string, BenchmarkJobRecord>;
};

type LegacyBenchmarkLedger = {
  version: 1;
  jobs: Record<string, BenchmarkJobRecord>;
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
      ? {
          requestConfigurationVersion: 1 as const,
          requestConfiguration: args.requestConfiguration,
        }
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
    (configuration.requestConfigurationVersion === undefined ||
      configuration.requestConfigurationVersion === 1) &&
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

// Adds to a cumulative counter while preserving the untracked state
// A job that never recorded this counter stays undefined rather than reporting a
// total silently omitting its earlier runs
function addToCounter(
  current: BenchmarkJobRecord | undefined,
  counter: keyof BenchmarkJobCounters,
  increment: number,
): number | undefined {
  const value = current?.[counter];
  if (increment <= 0) return value;
  if (!current) return increment;
  if (!isNonNegativeInteger(value)) return undefined;
  return value + increment;
}

function appendUniqueAttempt(attempts: number[] | undefined, attempt: number): number[] {
  const next = new Set(attempts ?? []);
  next.add(attempt);
  return Array.from(next).sort((a, b) => a - b);
}

// A response already recorded for this attempt is now known to be rejected
// Returns the updated attempt list plus the resulting cumulative count
function rejectAttempt(
  current: BenchmarkJobRecord | undefined,
  attempt: number,
): { rejectedRunAttempts: number[] | undefined; rejectedResponseCount: number | undefined } {
  const responded = (current?.completedRunAttempts ?? []).includes(attempt);
  if (!responded) {
    return {
      rejectedRunAttempts: current?.rejectedRunAttempts,
      rejectedResponseCount: current?.rejectedResponseCount,
    };
  }

  const rejectedRunAttempts = appendUniqueAttempt(current?.rejectedRunAttempts, attempt);
  const newlyRejected = rejectedRunAttempts.length - (current?.rejectedRunAttempts?.length ?? 0);
  return {
    rejectedRunAttempts,
    rejectedResponseCount: addToCounter(current, "rejectedResponseCount", newlyRejected),
  };
}

// Fields measured from one finalized cohort, refreshed as a set
const COHORT_MEASUREMENT_FIELDS = [
  "inferenceSampleCount",
  "configurationSampleCount",
  "configurationIsConsistent",
  "outputCapSampleCount",
  "outputCapIsConsistent",
  "averageInferenceMs",
  "finalizedAttemptCount",
  "outputCapTokens",
] as const satisfies readonly (keyof GeneratedModelBenchmarkMetrics)[];

// Coverage denominator published alongside a counter, so a reader can tell an
// exact total from one the cohort could not fully track
const COUNTER_COVERAGE_FIELDS = {
  providerCallCount: "providerCallTrackingJobCount",
  completedAttemptCount: "completedAttemptTrackingJobCount",
} as const satisfies Partial<
  Record<keyof BenchmarkJobCounters, keyof GeneratedModelBenchmarkMetrics>
>;

// Counters accumulated across every run, plus the denominators they publish
const CUMULATIVE_COUNTER_FIELDS = [
  ...ZEROED_COUNTERS,
  ...Object.values(COUNTER_COVERAGE_FIELDS),
] as const satisfies readonly (keyof GeneratedModelBenchmarkMetrics)[];

function pickDefined<K extends keyof GeneratedModelBenchmarkMetrics>(
  metrics: GeneratedModelBenchmarkMetrics,
  fields: readonly K[],
): Partial<Pick<GeneratedModelBenchmarkMetrics, K>> {
  const picked: Partial<Pick<GeneratedModelBenchmarkMetrics, K>> = {};
  for (const field of fields) {
    if (metrics[field] !== undefined) picked[field] = metrics[field];
  }
  return picked;
}

function trackingJobCount(
  records: (BenchmarkJobRecord | undefined)[],
  counter: keyof BenchmarkJobCounters,
): number {
  return records.filter((record) => isNonNegativeInteger(record?.[counter])).length;
}

// Totals a counter only when every job in the cohort tracked it
// A partial cohort omits the field rather than publishing a total that silently
// excludes the untracked jobs
function sumTrackedCounters(
  records: (BenchmarkJobRecord | undefined)[],
  expectedBuildCount: number,
): BenchmarkJobCounters {
  if (records.length !== expectedBuildCount) return {};

  const totals: BenchmarkJobCounters = {};
  for (const counter of ZEROED_COUNTERS) {
    if (trackingJobCount(records, counter) !== expectedBuildCount) continue;
    totals[counter] = records.reduce((sum, record) => sum + (record?.[counter] ?? 0), 0);
  }
  return totals;
}

// Publishes a denominator only for counters that produced a total
function counterCoverage(
  records: (BenchmarkJobRecord | undefined)[],
  totals: BenchmarkJobCounters,
): Partial<GeneratedModelBenchmarkMetrics> {
  const coverage: Partial<GeneratedModelBenchmarkMetrics> = {};
  for (const [counter, field] of Object.entries(COUNTER_COVERAGE_FIELDS) as [
    keyof BenchmarkJobCounters,
    (typeof COUNTER_COVERAGE_FIELDS)[keyof typeof COUNTER_COVERAGE_FIELDS],
  ][]) {
    if (totals[counter] === undefined) continue;
    coverage[field] = trackingJobCount(records, counter);
  }
  return coverage;
}

function configurationMatchesJob(
  configuration: BenchmarkRunConfiguration | undefined,
  job: BenchmarkMetricJob,
): configuration is BenchmarkRunConfiguration {
  return (
    isBenchmarkRunConfiguration(configuration) &&
    configuration.requestConfigurationVersion === 1 &&
    typeof configuration.requestConfiguration === "string" &&
    typeof job.promptText === "string" &&
    configuration.promptSha256 === sha256(job.promptText)
  );
}

// Version 1 counted outer attempts and stored requested configuration traces
// Neither value is exact under the provider-boundary telemetry contract
function migrateLegacyRecord(record: BenchmarkJobRecord): void {
  const legacy = record as BenchmarkJobRecord & { totalAttemptCount?: number };
  delete legacy.totalAttemptCount;
  delete record.providerCallCount;
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
    const ledger = readJsonFile<BenchmarkLedger | LegacyBenchmarkLedger>(
      this.ledgerPath,
      { version: 2, jobs: {} },
    );
    if (!ledger.jobs || typeof ledger.jobs !== "object") {
      return { version: 2, jobs: {} };
    }
    if (ledger.version === 1) {
      for (const record of Object.values(ledger.jobs)) {
        migrateLegacyRecord(record);
      }
      return { version: 2, jobs: ledger.jobs };
    }
    return ledger.version === 2 ? ledger : { version: 2, jobs: {} };
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
        ...carriedCounters(current),
        // A job with no prior record starts every counter at zero so its cohort
        // can report exact totals
        ...(current
          ? {}
          : Object.fromEntries(ZEROED_COUNTERS.map((counter) => [counter, 0]))),
        state: "running",
        startedAt: now.toISOString(),
        retryCount: 0,
        runAttemptCount: 0,
        completedRunAttempts: [],
        rejectedRunAttempts: [],
        ownerPid: process.pid,
        sample: current?.sample,
        generatedMetricsDirty: true,
      };
    });
  }

  markProviderCall(job: BenchmarkMetricJob, attempt: number): void {
    if (!isPositiveInteger(attempt)) {
      throw new Error(`Provider call attempt must be a positive integer, received ${attempt}.`);
    }
    this.updateRecord(job, (current) => {
      const runAttemptCount = Math.max(current?.runAttemptCount ?? 0, attempt);
      return {
        ...this.ongoingRecord(current),
        runAttemptCount,
        completedRunAttempts: current?.completedRunAttempts ?? [],
        rejectedRunAttempts: current?.rejectedRunAttempts ?? [],
        providerCallCount: addToCounter(current, "providerCallCount", 1),
      };
    });
  }

  markCompletedAttempt(job: BenchmarkMetricJob, attempt: number): void {
    if (!isPositiveInteger(attempt)) {
      throw new Error(`Completed attempt must be a positive integer, received ${attempt}.`);
    }
    this.updateRecord(job, (current) => {
      const completedRunAttempts = appendUniqueAttempt(current?.completedRunAttempts, attempt);
      const newlyCompleted =
        completedRunAttempts.length - (current?.completedRunAttempts?.length ?? 0);
      return {
        ...this.ongoingRecord(current),
        completedRunAttempts,
        rejectedRunAttempts: current?.rejectedRunAttempts ?? [],
        completedAttemptCount: addToCounter(current, "completedAttemptCount", newlyCompleted),
      };
    });
  }

  markRetry(job: BenchmarkMetricJob, attempt: number): void {
    this.updateRecord(job, (current) => {
      const retryCount = Math.max(current?.retryCount ?? 0, attempt - 1);
      const priorAttempt = attempt - 1;
      // A retry fails only a preceding attempt that reached a provider request
      const newlyFailed =
        retryCount > (current?.retryCount ?? 0) &&
        (current?.runAttemptCount ?? 0) >= priorAttempt
          ? 1
          : 0;
      return {
        ...this.ongoingRecord(current),
        ...rejectAttempt(current, attempt - 1),
        retryCount,
        completedRunAttempts: current?.completedRunAttempts ?? [],
        failedAttemptCount: addToCounter(current, "failedAttemptCount", newlyFailed),
      };
    });
  }

  // Baseline for a mid-run transition: keep the job running and carry every
  // counter and attempt list forward so callers override only what changed
  private ongoingRecord(current: BenchmarkJobRecord | undefined): BenchmarkJobRecord {
    return {
      ...current,
      ...carriedCounters(current),
      ...carriedRunState(current),
      state: current?.state ?? "running",
      startedAt: current?.startedAt ?? new Date().toISOString(),
      retryCount: current?.retryCount ?? 0,
      ownerPid: current?.ownerPid ?? process.pid,
    };
  }

  markFailed(
    job: BenchmarkMetricJob,
    error: string,
    durationMs?: number,
    now = new Date(),
  ): void {
    this.updateRecord(job, (current) => {
      // Re-failing an already failed job must not double-count the run
      const newlyFailedRuns = current?.state === "failed" ? 0 : 1;
      const terminalAttempt = current?.runAttemptCount ?? 0;
      // The terminal attempt only counts as failed if it actually started
      const newlyFailedAttempts =
        newlyFailedRuns > 0 && terminalAttempt > (current?.retryCount ?? 0) ? 1 : 0;
      return {
        ...carriedCounters(current),
        ...carriedRunState(current),
        ...(newlyFailedRuns > 0 ? rejectAttempt(current, terminalAttempt) : {}),
        state: "failed",
        startedAt: current?.startedAt ?? now.toISOString(),
        endedAt: now.toISOString(),
        retryCount: current?.retryCount ?? 0,
        completedRunAttempts: current?.completedRunAttempts ?? [],
        error,
        lastRunDurationMs: isNonNegativeInteger(durationMs) ? durationMs : undefined,
        failedAttemptCount: addToCounter(current, "failedAttemptCount", newlyFailedAttempts),
        failedRunCount: (current?.failedRunCount ?? 0) + newlyFailedRuns,
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
        ...carriedCounters(current),
        ...carriedRunState(current),
        state: "interrupted",
        startedAt,
        endedAt: now.toISOString(),
        retryCount: current?.retryCount ?? 0,
        error: reason,
        lastRunDurationMs: Number.isFinite(elapsed) ? Math.round(elapsed) : undefined,
        interruptedRunCount:
          (current?.interruptedRunCount ?? 0) + (current?.state === "interrupted" ? 0 : 1),
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
      return {
        ...carriedCounters(current),
        ...carriedRunState(current),
        state: "finalizing",
        startedAt: current?.startedAt ?? now.toISOString(),
        retryCount,
        runAttemptCount: sample.attemptCount,
        ownerPid: process.pid,
        sample: current?.sample,
        pendingSample: sample,
        generatedMetricsDirty: true,
      };
    });
    atomicWriteText(job.filePath, serializedBuild);
    this.updateRecord(job, (current) => ({
      ...carriedCounters(current),
      ...carriedRunState(current),
      state: "succeeded",
      startedAt: current?.startedAt ?? now.toISOString(),
      endedAt: now.toISOString(),
      retryCount: Math.max(0, sample.attemptCount - 1),
      sample,
      generatedMetricsDirty: true,
    }));
    return sample;
  }

  reconcile(
    jobs: BenchmarkMetricJob[],
    now = new Date(),
    options: { verifySucceededArtifacts?: boolean } = {},
  ): { warnings: string[]; refreshRequired: boolean } {
    return this.withLedgerLock(() => {
      const ledger = this.readLedger();
      const warnings: string[] = [];
      let changed = false;
      let refreshRequired = false;

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

        if (current.generatedMetricsDirty !== false) refreshRequired = true;

        if (current.state === "running") {
          ledger.jobs[key] = {
            ...current,
            state: "interrupted",
            endedAt: now.toISOString(),
            error: "Previous process ended before this job finalized.",
            lastRunDurationMs: Math.max(0, now.getTime() - Date.parse(current.startedAt)),
            interruptedRunCount: (current.interruptedRunCount ?? 0) + 1,
            ownerPid: undefined,
            generatedMetricsDirty: true,
          };
          changed = true;
          refreshRequired = true;
          continue;
        }

        if (current.state === "finalizing" && isBenchmarkSample(current.pendingSample)) {
          const artifact = verifiedArtifact(job.filePath);
          const resumed = {
            ...carriedCounters(current),
            ...carriedRunState(current),
            startedAt: current.startedAt,
            endedAt: now.toISOString(),
            retryCount: current.retryCount,
          };
          if (artifact?.hash === current.pendingSample.artifactSha256) {
            ledger.jobs[key] = {
              ...resumed,
              state: "succeeded",
              sample: current.pendingSample,
              generatedMetricsDirty: true,
            };
            refreshRequired = true;
          } else {
            ledger.jobs[key] = {
              ...resumed,
              state: "interrupted",
              error: "Final artifact did not match the pending benchmark sample.",
              interruptedRunCount: (current.interruptedRunCount ?? 0) + 1,
              sample: current.sample,
              generatedMetricsDirty: true,
            };
            refreshRequired = true;
          }
          changed = true;
          continue;
        }

        if (!isBenchmarkSample(current.sample) || options.verifySucceededArtifacts === false) {
          continue;
        }
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
            generatedMetricsDirty: true,
          };
          changed = true;
          refreshRequired = true;
        }
      }

      if (changed) this.writeLedger(ledger);
      return { warnings, refreshRequired };
    });
  }

  private persistGeneratedMetrics(
    jobsByModel: ReadonlyMap<ModelKey, BenchmarkMetricJob[]>,
    aggregatedLedger: BenchmarkLedger,
    updates: ReadonlyMap<ModelKey, GeneratedModelBenchmarkMetrics>,
  ): void {
    this.withLedgerLock(() => {
      const ledger = this.readLedger();
      const recordIsCurrent = (job: BenchmarkMetricJob) => {
        const key = jobKey(job);
        return JSON.stringify(ledger.jobs[key]) === JSON.stringify(aggregatedLedger.jobs[key]);
      };
      const persisted = readJsonFile<GeneratedBenchmarkMetrics>(
        this.generatedMetricsPath,
        { version: 1, models: {} },
      );
      let metricsChanged = false;
      for (const [modelKey, metrics] of updates) {
        const modelJobs = jobsByModel.get(modelKey) ?? [];
        if (modelJobs.some((job) => !recordIsCurrent(job))) continue;
        if (JSON.stringify(persisted.models[modelKey]) === JSON.stringify(metrics)) continue;
        persisted.models[modelKey] = metrics;
        metricsChanged = true;
      }
      if (metricsChanged) atomicWriteJson(this.generatedMetricsPath, persisted);

      // Dirty markers acknowledge the generated write and must follow it
      let ledgerChanged = false;
      for (const modelJobs of jobsByModel.values()) {
        for (const job of modelJobs) {
          const key = jobKey(job);
          const current = ledger.jobs[key];
          if (!current || current.generatedMetricsDirty === false || !recordIsCurrent(job)) continue;
          ledger.jobs[key] = { ...current, generatedMetricsDirty: false };
          ledgerChanged = true;
        }
      }
      if (ledgerChanged) this.writeLedger(ledger);
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
    const persistedUpdates = new Map<ModelKey, GeneratedModelBenchmarkMetrics>();
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
      const completeMeasurementProvenance =
        completeConfigurations && outputCaps.length === expectedBuildCount;
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
      const counterTotals = sumTrackedCounters(records, expectedBuildCount);
      const metrics: GeneratedModelBenchmarkMetrics = {
        expectedBuildCount,
        finalizedBuildCount,
        inferenceSampleCount: timingSamples.length,
        ...counterCoverage(records, counterTotals),
        configurationSampleCount: configuredSamples.length,
        configurationIsConsistent,
        outputCapSampleCount: outputCaps.length,
        outputCapIsConsistent,
        ...counterTotals,
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
        ...(outputCapIsConsistent ? { outputCapTokens: outputCaps[0] } : {}),
      };
      computed.models[modelKey] = metrics;

      if (!completeArtifacts) continue;

      const previous = persisted.models[modelKey];
      // Replace cohort measurements together only with complete
      // provider-accepted configuration and output-cap provenance
      const next: GeneratedModelBenchmarkMetrics = {
        inferenceSampleCount: metrics.inferenceSampleCount,
        ...previous,
        expectedBuildCount,
        finalizedBuildCount,
        promptCohortId: promptCohortId(
          Object.fromEntries(
            uniqueJobs.map((job) => [
              job.promptSlug,
              job.promptText ?? BENCHMARK_PROMPT_MAP[job.promptSlug] ?? "",
            ]),
          ),
        ),
        averageJsonSizeBytes: metrics.averageJsonSizeBytes,
        ...(completeMeasurementProvenance
          ? pickDefined(metrics, COHORT_MEASUREMENT_FIELDS)
          : {}),
        // Cumulative counters cover the job's whole history rather than one
        // cohort, so they refresh as soon as the cohort tracks them fully
        ...pickDefined(metrics, CUMULATIVE_COUNTER_FIELDS),
      };

      if (completeMeasurementProvenance) {
        for (const field of COHORT_MEASUREMENT_FIELDS) {
          if (metrics[field] === undefined) delete next[field];
        }
      }

      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        persistedUpdates.set(modelKey, next);
      }
    }

    this.persistGeneratedMetrics(jobsByModel, ledger, persistedUpdates);
    return computed;
  }

  summarize(
    jobs: BenchmarkMetricJob[],
    options: { refreshArtifacts?: boolean } = {},
  ): Map<ModelKey, BenchmarkModelSummary> {
    const generated = options.refreshArtifacts === false
      ? readJsonFile<GeneratedBenchmarkMetrics>(
          this.generatedMetricsPath,
          { version: 1, models: {} },
        )
      : this.refreshGeneratedMetrics(jobs);
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
