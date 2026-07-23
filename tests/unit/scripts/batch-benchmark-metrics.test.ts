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
const castleConfiguration = createBenchmarkRunConfiguration({
  promptText: castle.promptText!,
  providerRoute: "direct",
  reasoningOverride: null,
  toolsEnabled: true,
});

store.markRunning(castle, new Date("2026-07-22T18:00:00.000Z"));
store.markRetry(castle, 2);
store.markRetry(castle, 3);
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

let generated = store.refreshGeneratedMetrics([castle]);
assert.deepEqual(generated.models.openai_gpt_5_6_sol, {
  expectedBuildCount: 1,
  finalizedBuildCount: 1,
  inferenceSampleCount: 1,
  configurationSampleCount: 1,
  configurationIsConsistent: true,
  outputCapSampleCount: 1,
  outputCapIsConsistent: true,
  averageJsonSizeBytes: Buffer.byteLength(castleJson),
  averageInferenceMs: 1_046_000,
  outputCapTokens: 128_000,
});

store.markRunning(castle, new Date("2026-07-22T19:00:00.000Z"));
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
assert.equal(summary?.averageInferenceMs, 1_046_000);

store.markRunning(castle, new Date("2026-07-22T20:00:00.000Z"));
store.reconcile([castle], new Date("2026-07-22T20:00:10.000Z"));
assert.equal(readLedger().jobs["openai_gpt_5_6_sol/castle"]?.state, "interrupted");
summary = store.summarize([castle]).get("openai_gpt_5_6_sol");
assert.equal(summary?.interruptedCount, 1);
assert.equal(summary?.averageInferenceMs, 1_046_000);

store.markRunning(castle, new Date("2026-07-22T20:30:00.000Z"));
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
    reasoningOverride: null,
    toolsEnabled: true,
  }),
};
const ledger = readLedger();
ledger.jobs["openai_gpt_5_6_sol/phoenix"] = {
  state: "finalizing",
  startedAt: "2026-07-22T21:00:00.000Z",
  retryCount: 0,
  pendingSample: phoenixSample,
};
writeFileSync(ledgerPath, `${JSON.stringify({ version: 1, jobs: ledger.jobs }, null, 2)}\n`);
store.reconcile([castle, phoenix], new Date("2026-07-22T21:02:00.000Z"));
assert.equal(
  readLedger().jobs["openai_gpt_5_6_sol/phoenix"]?.state,
  "succeeded",
  "matching finalization state should recover after a process crash",
);

generated = store.refreshGeneratedMetrics([castle, phoenix]);
assert.equal(generated.models.openai_gpt_5_6_sol?.finalizedBuildCount, 2);
assert.equal(generated.models.openai_gpt_5_6_sol?.inferenceSampleCount, 2);
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
      configurationSampleCount: 1,
      configurationIsConsistent: true,
      outputCapSampleCount: 1,
      outputCapIsConsistent: true,
      averageInferenceMs: 456_000,
      averageJsonSizeBytes: 123_456,
      outputCapTokens: 128_000,
    },
  },
};
writeFileSync(checkoutMetricsPath, `${JSON.stringify(committedMetrics, null, 2)}\n`);
const checkoutStore = new BenchmarkMetricsStore({
  ledgerPath: join(checkoutRoot, "uploads", ".benchmark-metrics.json"),
  generatedMetricsPath: checkoutMetricsPath,
});
const committedContents = readFileSync(checkoutMetricsPath, "utf8");
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
  models: { openai_gpt_5_6_sol: Record<string, number | boolean> };
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

console.log("batch benchmark metric lifecycle checks passed");
