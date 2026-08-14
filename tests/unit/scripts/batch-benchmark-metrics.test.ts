import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptCohortId } from "../../../lib/benchmark/promptCohortId";

import {
  BenchmarkMetricsStore,
  createBenchmarkRunConfiguration,
  type BenchmarkMetricJob,
} from "../../../scripts/benchmarkMetrics";

const root = mkdtempSync(join(tmpdir(), "minebench-benchmark-metrics-"));
const uploads = join(root, "uploads");
const ledgerPath = join(uploads, ".benchmark-metrics.json");
const generatedMetricsPath = join(root, "modelBenchmarkMetrics.generated.json");
const store = new BenchmarkMetricsStore({ ledgerPath, generatedMetricsPath });

function job(promptSlug: string): BenchmarkMetricJob {
  return {
    promptSlug,
    promptText: `Build prompt for ${promptSlug}`,
    modelKey: "openai_gpt_5_6_sol",
    modelSlug: "gpt-5-6-sol",
    filePath: join(uploads, promptSlug, `${promptSlug}-gpt-5-6-sol.json`),
  };
}

function readLedger() {
  return JSON.parse(readFileSync(ledgerPath, "utf8")) as {
    jobs: Record<string, Record<string, unknown>>;
  };
}

const castle = job("castle");
const castleJson = JSON.stringify(
  { version: "1.0", blocks: [{ x: 1, y: 2, z: 3, type: "stone" }] },
  null,
  2,
);
const effectiveRequestConfiguration =
  "Request config: api_mode=responses_sync, max_output_tokens=128000, reasoning_max_tokens=n/a, thinking_mode=reasoning=max, temperature=default, text_verbosity=high, response_format=json_schema.";
const castleConfiguration = createBenchmarkRunConfiguration({
  promptText: castle.promptText!,
  providerRoute: "direct",
  reasoningOverride: null,
  requestConfiguration: effectiveRequestConfiguration,
  toolsEnabled: true,
});

store.markRunning(castle, new Date("2026-07-22T18:00:00.000Z"));
store.markProviderCall(castle, 1);
store.markCompletedAttempt(castle, 1);
store.markCompletedAttempt(castle, 1);
store.markRetry(castle, 2);
store.markProviderCall(castle, 2);
store.markCompletedAttempt(castle, 2);
store.markRetry(castle, 3);
store.markProviderCall(castle, 3);
const castleSample = store.finalizeSuccess(
  castle,
  castleJson,
  {
    inferenceTimeMs: 1_046_000,
    attemptCount: 3,
    acceptedOutputTokens: 128_000,
    configuration: castleConfiguration,
  },
  new Date("2026-07-22T18:17:26.000Z"),
);

assert.equal(readFileSync(castle.filePath, "utf8"), castleJson);
assert.equal(castleSample.inferenceTimeMs, 1_046_000);
assert.equal(castleSample.jsonBytes, Buffer.byteLength(castleJson));
assert.equal(castleSample.attemptCount, 3);
assert.equal(castleSample.acceptedOutputTokens, 128_000);
assert.equal(
  castleSample.artifactSha256,
  createHash("sha256").update(castleJson).digest("hex"),
);
assert.equal(readLedger().jobs["openai_gpt_5_6_sol/castle"]?.state, "succeeded");
assert.equal(
  store.reconcile([castle], new Date(), { verifySucceededArtifacts: false }).refreshRequired,
  true,
  "a finalized sample must remain pending until generated metrics refresh",
);
store.markInterrupted(castle, "Interrupted after generation finalized.");
assert.equal(
  readLedger().jobs["openai_gpt_5_6_sol/castle"]?.state,
  "succeeded",
  "an upload-window signal must not overwrite a finalized generation",
);
assert.equal(
  readLedger().jobs["openai_gpt_5_6_sol/castle"]?.interruptedRunCount,
  0,
  "a finalized generation must not add an interrupted run",
);
assert.equal(
  readdirSync(join(uploads, "castle")).some((name) => name.endsWith(".tmp")),
  false,
  "atomic finalization should not leave temporary files",
);

const internalFallback = job("internal-fallback");
store.markRunning(internalFallback);
store.markProviderCall(internalFallback, 1);
store.markProviderCall(internalFallback, 1);
assert.equal(
  readLedger().jobs["openai_gpt_5_6_sol/internal-fallback"]?.providerCallCount,
  2,
  "internal provider fallbacks should count each outbound request",
);
assert.equal(
  readLedger().jobs["openai_gpt_5_6_sol/internal-fallback"]?.runAttemptCount,
  1,
  "internal provider fallbacks should remain within one outer attempt",
);

let generated = store.refreshGeneratedMetrics([castle]);
assert.equal(
  store.reconcile([castle], new Date(), { verifySucceededArtifacts: false }).refreshRequired,
  false,
  "a successful generated-metrics refresh should clear the pending marker",
);
assert.deepEqual(generated.models.openai_gpt_5_6_sol, {
  expectedBuildCount: 1,
  finalizedBuildCount: 1,
  inferenceSampleCount: 1,
  finalizedAttemptCount: 3,
  providerCallTrackingJobCount: 1,
  providerCallCount: 3,
  completedAttemptTrackingJobCount: 1,
  completedAttemptCount: 3,
  rejectedResponseCount: 2,
  configurationSampleCount: 1,
  configurationIsConsistent: true,
  outputCapSampleCount: 1,
  outputCapIsConsistent: true,
  averageJsonSizeBytes: Buffer.byteLength(castleJson),
  averageInferenceMs: 1_046_000,
  outputCapTokens: 128_000,
  failedAttemptCount: 2,
  failedRunCount: 0,
  interruptedRunCount: 0,
});
const castleCohortId = promptCohortId({ castle: castle.promptText! });
const persistedCastleMetrics = JSON.parse(readFileSync(generatedMetricsPath, "utf8")) as {
  models: { openai_gpt_5_6_sol: { promptCohortId?: string } };
};
assert.equal(persistedCastleMetrics.models.openai_gpt_5_6_sol.promptCohortId, castleCohortId);

const changedPromptCastle = { ...castle, promptText: "A changed castle prompt" };
store.refreshGeneratedMetrics([changedPromptCastle]);
const changedPromptMetrics = JSON.parse(readFileSync(generatedMetricsPath, "utf8")) as {
  models: { openai_gpt_5_6_sol: { promptCohortId?: string } };
};
assert.notEqual(promptCohortId({ castle: changedPromptCastle.promptText }), castleCohortId);
assert.equal(
  changedPromptMetrics.models.openai_gpt_5_6_sol.promptCohortId,
  castleCohortId,
  "an artifact generated for an older prompt must not claim the current cohort identity",
);

const unmarkedV2Ledger = readLedger();
delete unmarkedV2Ledger.jobs["openai_gpt_5_6_sol/castle"]?.generatedMetricsDirty;
writeFileSync(
  ledgerPath,
  `${JSON.stringify({ version: 2, jobs: unmarkedV2Ledger.jobs }, null, 2)}\n`,
);
assert.equal(
  store.reconcile([castle], new Date(), { verifySucceededArtifacts: false }).refreshRequired,
  true,
  "an unmarked version 2 record must receive one generated-metrics refresh",
);
store.refreshGeneratedMetrics([castle]);
assert.equal(
  store.reconcile([castle], new Date(), { verifySucceededArtifacts: false }).refreshRequired,
  false,
  "the migration refresh must persist its acknowledgement",
);

store.markRunning(castle, new Date("2026-07-22T19:00:00.000Z"));
store.markProviderCall(castle, 1);
store.markFailed(
  castle,
  "Provider quota exhausted",
  25_000,
  new Date("2026-07-22T19:00:25.000Z"),
);
assert.equal(
  store.getSample(castle)?.inferenceTimeMs,
  1_046_000,
  "a failed overwrite should retain the finalized artifact measurement",
);
let summary = store.summarize([castle]).get("openai_gpt_5_6_sol");
assert.equal(summary?.failedCount, 1);
assert.equal(
  summary?.failedAttemptCount,
  3,
  "failed attempts should include two retry-triggering failures and the terminal failed run",
);
assert.equal(
  summary?.completedAttemptCount,
  3,
  "a provider failure without response text must not count as a completed attempt",
);
assert.equal(
  summary?.rejectedResponseCount,
  2,
  "a provider failure without response text must not count as a rejected response",
);
assert.equal(summary?.averageInferenceMs, 1_046_000);

store.markRunning(castle, new Date("2026-07-22T20:00:00.000Z"));
store.markProviderCall(castle, 1);
store.reconcile([castle], new Date("2026-07-22T20:00:10.000Z"));
assert.equal(readLedger().jobs["openai_gpt_5_6_sol/castle"]?.state, "interrupted");
summary = store.summarize([castle]).get("openai_gpt_5_6_sol");
assert.equal(summary?.interruptedCount, 1);
assert.equal(summary?.averageInferenceMs, 1_046_000);

store.markRunning(castle, new Date("2026-07-22T20:30:00.000Z"));
store.markProviderCall(castle, 1);
store.finalizeSuccess(
  castle,
  castleJson,
  {
    inferenceTimeMs: 1_046_000,
    attemptCount: 1,
    acceptedOutputTokens: 128_000,
    configuration: castleConfiguration,
  },
  new Date("2026-07-22T20:47:26.000Z"),
);
summary = store.summarize([castle]).get("openai_gpt_5_6_sol");
assert.equal(summary?.failedCount, 1, "a later success should retain the failed run count");
assert.equal(
  summary?.providerCallCount,
  6,
  "total attempts should retain successful, failed, and interrupted run history",
);
assert.equal(
  summary?.completedAttemptCount,
  4,
  "completed attempts should retain valid and rejected response history only",
);
assert.equal(
  summary?.finalizedAttemptCount,
  1,
  "a resumed success should replace the finalized cohort's prior attempt count",
);
assert.equal(
  summary?.interruptedCount,
  1,
  "a later success should retain the interrupted run count",
);

const correctedCastleJson = JSON.stringify(
  {
    version: "1.0",
    blocks: [
      { x: 1, y: 2, z: 3, type: "stone" },
      { x: 4, y: 5, z: 6, type: "stone" },
    ],
  },
  null,
  2,
);
writeFileSync(castle.filePath, correctedCastleJson);
const startupReconciliation = store.reconcile([castle], new Date(), {
  verifySucceededArtifacts: false,
});
assert.equal(startupReconciliation.refreshRequired, false);
assert.equal(
  store.getSample(castle)?.jsonBytes,
  Buffer.byteLength(castleJson),
  "startup reconciliation should not rescan finalized artifacts",
);
store.reconcile([castle]);
assert.equal(store.getSample(castle)?.jsonBytes, Buffer.byteLength(correctedCastleJson));
assert.equal(
  store.getSample(castle)?.inferenceTimeMs,
  1_046_000,
  "a valid artifact correction should not rewrite its generation time",
);

const phoenix = job("phoenix");
const phoenixJson = JSON.stringify(
  { version: "1.0", blocks: [{ x: 7, y: 8, z: 9, type: "stone" }] },
  null,
  2,
);
mkdirSync(join(uploads, "phoenix"), { recursive: true });
writeFileSync(phoenix.filePath, phoenixJson, { flag: "w" });
const phoenixSample = {
  inferenceTimeMs: 100_000,
  jsonBytes: Buffer.byteLength(phoenixJson),
  artifactSha256: createHash("sha256").update(phoenixJson).digest("hex"),
  attemptCount: 1,
  acceptedOutputTokens: 128_000,
  configuration: createBenchmarkRunConfiguration({
    promptText: phoenix.promptText!,
    providerRoute: "direct",
    reasoningOverride: "max",
    requestConfiguration: effectiveRequestConfiguration,
    toolsEnabled: true,
  }),
};
const ledger = readLedger();
ledger.jobs["openai_gpt_5_6_sol/phoenix"] = {
  state: "finalizing",
  startedAt: "2026-07-22T21:00:00.000Z",
  retryCount: 0,
  runAttemptCount: 1,
  completedRunAttempts: [1],
  rejectedRunAttempts: [],
  providerCallCount: 1,
  completedAttemptCount: 1,
  rejectedResponseCount: 0,
  failedAttemptCount: 0,
  failedRunCount: 0,
  interruptedRunCount: 0,
  pendingSample: phoenixSample,
};
writeFileSync(ledgerPath, `${JSON.stringify({ version: 2, jobs: ledger.jobs }, null, 2)}\n`);
const recovery = store.reconcile([castle, phoenix], new Date("2026-07-22T21:02:00.000Z"));
assert.equal(recovery.refreshRequired, true);
assert.equal(
  readLedger().jobs["openai_gpt_5_6_sol/phoenix"]?.state,
  "succeeded",
  "matching finalization state should recover after a process crash",
);

generated = store.refreshGeneratedMetrics([castle, phoenix]);
assert.equal(generated.models.openai_gpt_5_6_sol?.finalizedBuildCount, 2);
assert.equal(generated.models.openai_gpt_5_6_sol?.inferenceSampleCount, 2);
assert.equal(
  generated.models.openai_gpt_5_6_sol?.finalizedAttemptCount,
  2,
  "implicit and explicit reasoning inputs should aggregate when the effective request configuration matches",
);
assert.equal(generated.models.openai_gpt_5_6_sol?.providerCallCount, 7);
assert.equal(generated.models.openai_gpt_5_6_sol?.completedAttemptCount, 5);
assert.equal(generated.models.openai_gpt_5_6_sol?.rejectedResponseCount, 2);
assert.equal(
  generated.models.openai_gpt_5_6_sol?.averageInferenceMs,
  Math.round((1_046_000 + 100_000) / 2),
);

const mixedRoute = job("mixed-route");
store.markRunning(mixedRoute);
store.finalizeSuccess(
  mixedRoute,
  JSON.stringify(
    { version: "1.0", blocks: [{ x: 10, y: 11, z: 12, type: "stone" }] },
    null,
    2,
  ),
  {
    inferenceTimeMs: 200_000,
    attemptCount: 1,
    acceptedOutputTokens: 128_000,
    configuration: createBenchmarkRunConfiguration({
      promptText: mixedRoute.promptText!,
      providerRoute: "openrouter",
      reasoningOverride: null,
      requestConfiguration: effectiveRequestConfiguration,
      toolsEnabled: true,
    }),
  },
);
generated = store.refreshGeneratedMetrics([castle, phoenix, mixedRoute]);
assert.equal(generated.models.openai_gpt_5_6_sol?.configurationIsConsistent, false);
assert.equal(generated.models.openai_gpt_5_6_sol?.averageInferenceMs, undefined);
assert.equal(generated.models.openai_gpt_5_6_sol?.outputCapSampleCount, 3);
assert.equal(generated.models.openai_gpt_5_6_sol?.outputCapIsConsistent, true);
assert.equal(
  generated.models.openai_gpt_5_6_sol?.outputCapTokens,
  128_000,
  "route variation must not erase one consistent accepted cap",
);

const mixedCap = job("mixed-cap");
store.markRunning(mixedCap);
store.finalizeSuccess(
  mixedCap,
  JSON.stringify(
    { version: "1.0", blocks: [{ x: 13, y: 14, z: 15, type: "stone" }] },
    null,
    2,
  ),
  {
    inferenceTimeMs: 300_000,
    attemptCount: 1,
    acceptedOutputTokens: 64_000,
    configuration: createBenchmarkRunConfiguration({
      promptText: mixedCap.promptText!,
      providerRoute: "direct",
      reasoningOverride: null,
      requestConfiguration:
        "Request config: api_mode=responses_sync, max_output_tokens=64000, reasoning_max_tokens=n/a, thinking_mode=reasoning=max, temperature=default, text_verbosity=high, response_format=json_schema.",
      toolsEnabled: true,
    }),
  },
);
generated = store.refreshGeneratedMetrics([castle, phoenix, mixedCap]);
assert.equal(generated.models.openai_gpt_5_6_sol?.configurationIsConsistent, false);
assert.equal(generated.models.openai_gpt_5_6_sol?.outputCapSampleCount, 3);
assert.equal(generated.models.openai_gpt_5_6_sol?.outputCapIsConsistent, false);
assert.equal(
  generated.models.openai_gpt_5_6_sol?.averageInferenceMs,
  undefined,
  "timings from different accepted caps must not be averaged together",
);
assert.equal(
  generated.models.openai_gpt_5_6_sol?.outputCapTokens,
  undefined,
  "mixed accepted caps must not publish a static-looking cap",
);

writeFileSync(phoenix.filePath, "not json");
store.reconcile([phoenix]);
generated = store.refreshGeneratedMetrics([castle, phoenix]);
assert.equal(generated.models.openai_gpt_5_6_sol?.finalizedBuildCount, 1);
assert.equal(generated.models.openai_gpt_5_6_sol?.averageInferenceMs, undefined);
assert.equal(generated.models.openai_gpt_5_6_sol?.averageJsonSizeBytes, undefined);

const checkoutRoot = mkdtempSync(join(tmpdir(), "minebench-benchmark-checkout-"));
const checkoutMetricsPath = join(checkoutRoot, "modelBenchmarkMetrics.generated.json");
const checkoutJob: BenchmarkMetricJob = {
  promptSlug: "castle",
  promptText: "Build prompt for castle",
  modelKey: "openai_gpt_5_6_sol",
  modelSlug: "gpt-5-6-sol",
  filePath: join(checkoutRoot, "uploads", "castle", "castle-gpt-5-6-sol.json"),
};
const committedMetrics = {
  version: 1,
  models: {
    openai_gpt_5_6_sol: {
      expectedBuildCount: 1,
      finalizedBuildCount: 1,
      inferenceSampleCount: 1,
      finalizedAttemptCount: 2,
      providerCallTrackingJobCount: 1,
      providerCallCount: 5,
      completedAttemptTrackingJobCount: 1,
      completedAttemptCount: 4,
      rejectedResponseCount: 1,
      configurationSampleCount: 1,
      configurationIsConsistent: true,
      outputCapSampleCount: 1,
      outputCapIsConsistent: true,
      averageInferenceMs: 456_000,
      averageJsonSizeBytes: 123_456,
      outputCapTokens: 128_000,
      failedAttemptCount: 1,
      failedRunCount: 0,
      interruptedRunCount: 0,
    },
  },
};
writeFileSync(checkoutMetricsPath, `${JSON.stringify(committedMetrics, null, 2)}\n`);
const checkoutStore = new BenchmarkMetricsStore({
  ledgerPath: join(checkoutRoot, "uploads", ".benchmark-metrics.json"),
  generatedMetricsPath: checkoutMetricsPath,
});
const committedContents = readFileSync(checkoutMetricsPath, "utf8");
const persistedSummary = checkoutStore
  .summarize([checkoutJob], { refreshArtifacts: false })
  .get("openai_gpt_5_6_sol");
assert.equal(persistedSummary?.averageInferenceMs, 456_000);
assert.equal(persistedSummary?.averageJsonSizeBytes, 123_456);
assert.equal(
  readFileSync(checkoutMetricsPath, "utf8"),
  committedContents,
  "a persisted summary should not scan or rewrite local artifacts",
);
const emptyCheckoutMetrics = checkoutStore.refreshGeneratedMetrics([checkoutJob]);
assert.equal(emptyCheckoutMetrics.models.openai_gpt_5_6_sol?.finalizedBuildCount, 0);
assert.equal(
  readFileSync(checkoutMetricsPath, "utf8"),
  committedContents,
  "a status run with an incomplete local artifact cohort must not rewrite committed metrics",
);

mkdirSync(join(checkoutRoot, "uploads", "castle"), { recursive: true });
writeFileSync(checkoutJob.filePath, "{}\n");
const placeholderMetrics = checkoutStore.refreshGeneratedMetrics([checkoutJob]);
assert.equal(placeholderMetrics.models.openai_gpt_5_6_sol?.finalizedBuildCount, 0);
assert.equal(
  placeholderMetrics.models.openai_gpt_5_6_sol?.averageJsonSizeBytes,
  undefined,
  "newline-terminated placeholders must not contribute JSON-size metrics",
);
assert.equal(
  readFileSync(checkoutMetricsPath, "utf8"),
  committedContents,
  "a placeholder cohort must not rewrite committed metrics",
);

writeFileSync(checkoutJob.filePath, JSON.stringify({ error: "provider request failed" }));
const providerErrorMetrics = checkoutStore.refreshGeneratedMetrics([checkoutJob]);
assert.equal(providerErrorMetrics.models.openai_gpt_5_6_sol?.finalizedBuildCount, 0);
assert.equal(
  providerErrorMetrics.models.openai_gpt_5_6_sol?.averageJsonSizeBytes,
  undefined,
  "structured provider errors must not contribute JSON-size metrics",
);
assert.equal(
  readFileSync(checkoutMetricsPath, "utf8"),
  committedContents,
  "an invalid artifact cohort must not rewrite committed metrics",
);

const checkoutJson = JSON.stringify({
  version: "1.0",
  blocks: [{ x: 1, y: 1, z: 1, type: "stone" }],
});
writeFileSync(checkoutJob.filePath, checkoutJson);
const localCompleteMetrics = checkoutStore.refreshGeneratedMetrics([checkoutJob]);
assert.equal(localCompleteMetrics.models.openai_gpt_5_6_sol?.inferenceSampleCount, 0);
const refreshedCommittedMetrics = JSON.parse(readFileSync(checkoutMetricsPath, "utf8")) as {
  models: { openai_gpt_5_6_sol: Record<string, number | boolean | string> };
};
assert.equal(
  refreshedCommittedMetrics.models.openai_gpt_5_6_sol.averageJsonSizeBytes,
  Buffer.byteLength(checkoutJson),
);
assert.equal(
  refreshedCommittedMetrics.models.openai_gpt_5_6_sol.averageInferenceMs,
  456_000,
  "a complete artifact cohort without its gitignored ledger should preserve committed timing",
);
assert.equal(
  refreshedCommittedMetrics.models.openai_gpt_5_6_sol.outputCapTokens,
  128_000,
  "a complete artifact cohort without its gitignored ledger should preserve the committed cap",
);
assert.equal(
  refreshedCommittedMetrics.models.openai_gpt_5_6_sol.promptCohortId,
  undefined,
  "a complete artifact cohort without prompt provenance must not gain a cohort identity",
);

const terminalResponse = job("terminal-response");
store.markRunning(terminalResponse);
store.markProviderCall(terminalResponse, 1);
store.markCompletedAttempt(terminalResponse, 1);
store.markFailed(terminalResponse, "Could not find a valid JSON object");
summary = store.summarize([terminalResponse]).get("openai_gpt_5_6_sol");
assert.equal(summary?.providerCallCount, 1);
assert.equal(summary?.completedAttemptCount, 1);
assert.equal(summary?.rejectedResponseCount, 1);
assert.equal(summary?.failedAttemptCount, 1);

const preflightFailure = job("preflight-failure");
store.markRunning(preflightFailure);
store.markFailed(preflightFailure, "Missing API key");
summary = store.summarize([preflightFailure]).get("openai_gpt_5_6_sol");
assert.equal(summary?.providerCallCount, 0);
assert.equal(summary?.completedAttemptCount, 0);
assert.equal(summary?.failedAttemptCount, 0);
assert.equal(summary?.failedRunCount, 1);

const preflightRetries = job("preflight-retries");
store.markRunning(preflightRetries);
store.markRetry(preflightRetries, 2);
store.markRetry(preflightRetries, 3);
store.markFailed(preflightRetries, "hostname did not resolve");
summary = store.summarize([preflightRetries]).get("openai_gpt_5_6_sol");
assert.equal(summary?.providerCallCount, 0);
assert.equal(summary?.completedAttemptCount, 0);
assert.equal(summary?.failedAttemptCount, 0);
assert.equal(summary?.failedRunCount, 1);

const recoveredPreflightRetry = job("recovered-preflight-retry");
store.markRunning(recoveredPreflightRetry);
store.markRetry(recoveredPreflightRetry, 2);
store.markProviderCall(recoveredPreflightRetry, 2);
store.markCompletedAttempt(recoveredPreflightRetry, 2);
store.finalizeSuccess(recoveredPreflightRetry, castleJson, {
  inferenceTimeMs: 30_000,
  attemptCount: 2,
});
summary = store.summarize([recoveredPreflightRetry]).get("openai_gpt_5_6_sol");
assert.equal(summary?.providerCallCount, 1);
assert.equal(summary?.completedAttemptCount, 1);
assert.equal(summary?.failedAttemptCount, 0);
assert.equal(summary?.failedRunCount, 0);

const legacyRoot = mkdtempSync(join(tmpdir(), "minebench-legacy-benchmark-metrics-"));
const legacyJob: BenchmarkMetricJob = {
  ...job("legacy"),
  filePath: join(legacyRoot, "uploads", "legacy", "legacy-gpt-5-6-sol.json"),
};
const legacyJson = JSON.stringify({
  version: "1.0",
  blocks: [{ x: 1, y: 2, z: 3, type: "stone" }],
});
mkdirSync(join(legacyRoot, "uploads", "legacy"), { recursive: true });
writeFileSync(legacyJob.filePath, legacyJson);
const legacyConfiguration = {
  promptSha256: createHash("sha256").update(legacyJob.promptText!).digest("hex"),
  providerRoute: "direct",
  reasoningOverride: "max",
  requestConfiguration:
    "Request config: max_output_tokens=128000, thinking_mode=adaptive_effort=max->xhigh.",
  toolsEnabled: true,
};
const legacyLedgerPath = join(legacyRoot, "uploads", ".benchmark-metrics.json");
const legacyGeneratedMetricsPath = join(
  legacyRoot,
  "modelBenchmarkMetrics.generated.json",
);
writeFileSync(
  legacyGeneratedMetricsPath,
  `${JSON.stringify(committedMetrics, null, 2)}\n`,
);
writeFileSync(
  legacyLedgerPath,
  `${JSON.stringify(
    {
      version: 1,
      jobs: {
        "openai_gpt_5_6_sol/legacy": {
          state: "succeeded",
          startedAt: "2026-07-22T18:00:00.000Z",
          endedAt: "2026-07-22T18:01:00.000Z",
          retryCount: 2,
          totalAttemptCount: 3,
          providerCallCount: 3,
          completedAttemptCount: 3,
          rejectedResponseCount: 2,
          failedAttemptCount: 2,
          failedRunCount: 0,
          interruptedRunCount: 0,
          sample: {
            inferenceTimeMs: 60_000,
            jsonBytes: Buffer.byteLength(legacyJson),
            artifactSha256: createHash("sha256").update(legacyJson).digest("hex"),
            attemptCount: 3,
            acceptedOutputTokens: 128_000,
            configuration: legacyConfiguration,
          },
        },
      },
    },
    null,
    2,
  )}\n`,
);
const legacyStore = new BenchmarkMetricsStore({
  ledgerPath: legacyLedgerPath,
  generatedMetricsPath: legacyGeneratedMetricsPath,
});
const legacyMetrics =
  legacyStore.refreshGeneratedMetrics([legacyJob]).models.openai_gpt_5_6_sol;
assert.equal(
  legacyMetrics?.providerCallCount,
  undefined,
  "outer attempts from a version 1 ledger must not publish as provider calls",
);
assert.equal(legacyMetrics?.providerCallTrackingJobCount, undefined);
assert.equal(
  legacyMetrics?.configurationSampleCount,
  0,
  "requested fallback traces must not publish as accepted configurations",
);
assert.equal(legacyMetrics?.configurationIsConsistent, false);
assert.equal(legacyMetrics?.averageInferenceMs, undefined);
const migratedGeneratedMetrics = JSON.parse(
  readFileSync(legacyGeneratedMetricsPath, "utf8"),
) as {
  models: {
    openai_gpt_5_6_sol: Record<string, number | boolean>;
  };
};
assert.equal(
  migratedGeneratedMetrics.models.openai_gpt_5_6_sol.averageInferenceMs,
  456_000,
  "a legacy ledger must not erase committed timing",
);
assert.equal(
  migratedGeneratedMetrics.models.openai_gpt_5_6_sol.outputCapTokens,
  128_000,
  "a legacy ledger must not erase the committed output cap",
);
assert.equal(
  migratedGeneratedMetrics.models.openai_gpt_5_6_sol.configurationSampleCount,
  1,
  "a legacy ledger must preserve the committed configuration cohort",
);

const concurrentRoot = mkdtempSync(join(tmpdir(), "minebench-benchmark-concurrent-"));
const concurrentLedgerPath = join(concurrentRoot, ".benchmark-metrics.json");
const concurrentMetricsPath = join(concurrentRoot, "modelBenchmarkMetrics.generated.json");
const concurrentStore = new BenchmarkMetricsStore({
  ledgerPath: concurrentLedgerPath,
  generatedMetricsPath: concurrentMetricsPath,
});
const concurrentJobs: BenchmarkMetricJob[] = [
  { ...job("castle"), modelKey: "openai_gpt_5_6_sol" },
  {
    ...job("castle"),
    modelKey: "xai_grok_4_6",
    modelSlug: "grok-4-6",
    filePath: join(concurrentRoot, "castle-grok-4-6.json"),
  },
];
for (const concurrentJob of concurrentJobs) concurrentStore.markRunning(concurrentJob);
const concurrentLedger = concurrentStore["readLedger"]();
for (const [index, concurrentJob] of concurrentJobs.entries()) {
  concurrentStore["persistGeneratedMetrics"](
    new Map([[concurrentJob.modelKey, [concurrentJob]]]),
    concurrentLedger,
    new Map([
      [
        concurrentJob.modelKey,
        { expectedBuildCount: 1, finalizedBuildCount: 1, inferenceSampleCount: index + 1 },
      ],
    ]),
  );
}
const concurrentMetrics = JSON.parse(readFileSync(concurrentMetricsPath, "utf8")) as {
  models: Record<string, { inferenceSampleCount: number }>;
};
assert.equal(concurrentMetrics.models.openai_gpt_5_6_sol?.inferenceSampleCount, 1);
assert.equal(concurrentMetrics.models.xai_grok_4_6?.inferenceSampleCount, 2);
const concurrentFinalLedger = JSON.parse(readFileSync(concurrentLedgerPath, "utf8")) as {
  jobs: Record<string, { generatedMetricsDirty?: boolean }>;
};
assert.equal(concurrentFinalLedger.jobs["openai_gpt_5_6_sol/castle"]?.generatedMetricsDirty, false);
assert.equal(concurrentFinalLedger.jobs["xai_grok_4_6/castle"]?.generatedMetricsDirty, false);

// structured accepted-config records (ledger v2)
const acceptedConfiguration = {
  apiMode: "responses_sync",
  maxOutputTokens: 128_000,
  thinkingMode: "reasoning=max",
  temperature: "default" as const,
  textVerbosity: "high",
  responseFormat: "json_schema",
  providerRoute: "direct" as const,
  resolvedModelId: "gpt-5.6-sol",
};
const structuredConfiguration = createBenchmarkRunConfiguration({
  promptText: "Build prompt for structured",
  providerRoute: "direct",
  reasoningOverride: null,
  requestConfiguration: effectiveRequestConfiguration,
  acceptedConfiguration,
  toolsEnabled: true,
});
assert.equal(structuredConfiguration.requestConfigurationVersion, 2);
assert.deepEqual(structuredConfiguration.acceptedConfiguration, acceptedConfiguration);
assert.equal(
  structuredConfiguration.requestConfiguration,
  effectiveRequestConfiguration,
  "v2 must keep the prose line so mixed v1/v2 cohorts compare on the same key",
);
assert.equal(
  castleConfiguration.requestConfigurationVersion,
  1,
  "records without the structured object stay at version 1",
);

const structuredRoot = mkdtempSync(join(tmpdir(), "minebench-structured-benchmark-metrics-"));
const structuredJob: BenchmarkMetricJob = {
  ...job("structured"),
  filePath: join(structuredRoot, "uploads", "structured", "structured-gpt-5-6-sol.json"),
};
const structuredStore = new BenchmarkMetricsStore({
  ledgerPath: join(structuredRoot, "uploads", ".benchmark-metrics.json"),
  generatedMetricsPath: join(structuredRoot, "modelBenchmarkMetrics.generated.json"),
});
structuredStore.markRunning(structuredJob);
structuredStore.markProviderCall(structuredJob, 1);
structuredStore.markCompletedAttempt(structuredJob, 1);
structuredStore.finalizeSuccess(structuredJob, castleJson, {
  inferenceTimeMs: 45_000,
  attemptCount: 1,
  acceptedOutputTokens: 128_000,
  configuration: structuredConfiguration,
});
const structuredLedger = JSON.parse(
  readFileSync(join(structuredRoot, "uploads", ".benchmark-metrics.json"), "utf8"),
) as {
  jobs: Record<
    string,
    { sample?: { configuration?: { requestConfigurationVersion?: number; acceptedConfiguration?: unknown } } }
  >;
};
const persistedConfiguration =
  structuredLedger.jobs["openai_gpt_5_6_sol/structured"]?.sample?.configuration;
assert.equal(persistedConfiguration?.requestConfigurationVersion, 2);
assert.deepEqual(persistedConfiguration?.acceptedConfiguration, acceptedConfiguration);
const structuredSummary = structuredStore
  .summarize([structuredJob])
  .get("openai_gpt_5_6_sol");
assert.equal(
  structuredSummary?.configurationSampleCount,
  1,
  "a v2 sample must survive ledger validation on reload",
);
assert.equal(structuredSummary?.configurationIsConsistent, true);

console.log("batch benchmark metric lifecycle checks passed");
