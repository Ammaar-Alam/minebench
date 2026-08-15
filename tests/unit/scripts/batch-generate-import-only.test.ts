import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBenchmarkMetricJobs,
  clearRawAttemptResponses,
  getBenchmarkPromptSlugs,
  getCandidateModels,
  getAdminImportHeaders,
  getImportOnlyModelsForGenerationJobs,
  getJobsToGenerate,
  isEmptyPlaceholder,
  writeRawResponse,
} from "../../../scripts/batch-generate";
import type { ModelKey } from "../../../lib/ai/modelCatalog";
import { BENCHMARK_PROMPT_MAP } from "../../../scripts/uploadsCatalog";

function job(modelKey: ModelKey) {
  return { modelKey };
}

async function main() {
  const benchmarkPromptSlugs = getBenchmarkPromptSlugs();
  assert.deepEqual(benchmarkPromptSlugs, [
    "arcade",
    "astronaut",
    "carrier",
    "castle",
    "cottage",
    "fighter-jet",
    "floating",
    "knight",
    "locomotive",
    "phoenix",
    "shipwreck",
    "skyscraper",
    "steampunk",
    "treehouse",
    "worldtree",
  ]);
  const metricJobs = buildBenchmarkMetricJobs(["openai_gpt_5_6_sol"]);
  assert.deepEqual(
    metricJobs.map((candidate) => candidate.promptSlug),
    benchmarkPromptSlugs,
    "generated metrics must stay tied to the canonical benchmark prompt cohort",
  );
  assert.equal(
    metricJobs.some((candidate) => candidate.promptSlug === "local-only"),
    false,
    "custom upload folders must not change the published benchmark cohort",
  );
  assert.equal(
    metricJobs.find((candidate) => candidate.promptSlug === "castle")?.promptText,
    BENCHMARK_PROMPT_MAP.castle,
    "CLI prompt overrides must not change the canonical metric prompt hash",
  );

  const placeholderRoot = mkdtempSync(join(tmpdir(), "minebench-batch-placeholder-"));
  const placeholderPath = join(placeholderRoot, "build.json");
  writeFileSync(placeholderPath, "{}\n");
  assert.equal(
    isEmptyPlaceholder(placeholderPath),
    true,
    "LF-terminated placeholders should remain missing generation jobs",
  );
  writeFileSync(placeholderPath, "{}\r\n");
  assert.equal(
    isEmptyPlaceholder(placeholderPath),
    true,
    "CRLF-terminated placeholders should remain missing generation jobs",
  );

  const rawUploadsRoot = mkdtempSync(join(tmpdir(), "minebench-batch-raw-"));
  const rawJob = { promptSlug: "arcade", modelSlug: "opus-5" };
  const invalidAttempt = writeRawResponse(rawJob, "not valid JSON", {
    attempt: 1,
    uploadsDir: rawUploadsRoot,
  });
  assert.equal(
    invalidAttempt.filePath,
    join(
      rawUploadsRoot,
      "arcade",
      "RAW",
      "arcade-opus-5-RAW-attempt-01.txt",
    ),
  );
  assert.equal(readFileSync(invalidAttempt.filePath, "utf8"), "not valid JSON");

  const validAttempt = writeRawResponse(rawJob, '{"tool":"voxel.exec"}', {
    attempt: 2,
    uploadsDir: rawUploadsRoot,
  });
  assert.equal(
    validAttempt.filePath,
    join(
      rawUploadsRoot,
      "arcade",
      "RAW",
      "arcade-opus-5-RAW-attempt-02.json",
    ),
  );
  assert.equal(readFileSync(validAttempt.filePath, "utf8"), '{"tool":"voxel.exec"}');

  const canonicalRaw = writeRawResponse(rawJob, '{"tool":"voxel.exec"}', {
    uploadsDir: rawUploadsRoot,
  });
  clearRawAttemptResponses(rawJob, rawUploadsRoot);
  assert.equal(existsSync(canonicalRaw.filePath), true);
  assert.deepEqual(
    readdirSync(join(rawUploadsRoot, "arcade", "RAW")),
    ["arcade-opus-5-RAW.json"],
    "a new run should clear only prior attempt artifacts",
  );

  assert.ok(
    getCandidateModels([]).includes("openai_gpt_4_5_web_harness"),
    "default batch candidates should include import-only models for status/upload",
  );

  assert.deepEqual(
    getJobsToGenerate({
      generate: true,
      overwrite: false,
      modelFilters: [],
      allJobs: [
        job("openai_gpt_5_2"),
        job("openai_gpt_4_5_web_harness"),
      ],
      missingJobs: [
        job("openai_gpt_5_2"),
        job("openai_gpt_4_5_web_harness"),
      ],
    }).map((candidate) => candidate.modelKey),
    ["openai_gpt_5_2"],
  );

  assert.deepEqual(
    getJobsToGenerate({
      generate: true,
      overwrite: false,
      modelFilters: ["gpt"],
      allJobs: [
        job("openai_gpt_5_2"),
        job("openai_gpt_4_5_web_harness"),
      ],
      missingJobs: [
        job("openai_gpt_5_2"),
        job("openai_gpt_4_5_web_harness"),
      ],
    }).map((candidate) => candidate.modelKey),
    ["openai_gpt_5_2"],
  );

  assert.deepEqual(
    getJobsToGenerate({
      generate: true,
      overwrite: false,
      modelFilters: ["gpt-4-5-web-harness"],
      allJobs: [job("openai_gpt_4_5_web_harness")],
      missingJobs: [job("openai_gpt_4_5_web_harness")],
    }).map((candidate) => candidate.modelKey),
    ["openai_gpt_4_5_web_harness"],
  );

  assert.deepEqual(
    getImportOnlyModelsForGenerationJobs([
      job("openai_gpt_5_2"),
      job("anthropic_claude_sonnet_5"),
    ]),
    [],
  );

  const importOnlyModels = getImportOnlyModelsForGenerationJobs([
    job("openai_gpt_5_2"),
    job("openai_gpt_4_5_web_harness"),
  ]);

  assert.equal(importOnlyModels.length, 1);
  assert.equal(importOnlyModels[0].key, "openai_gpt_4_5_web_harness");
  assert.equal(importOnlyModels[0].importOnly, true);

  const originalBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    assert.deepEqual(getAdminImportHeaders("admin-token"), {
      Authorization: "Bearer admin-token",
      "Content-Type": "application/json",
    });

    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = " staging-bypass ";
    assert.equal(
      getAdminImportHeaders("admin-token")["x-vercel-protection-bypass"],
      "staging-bypass",
      "both import paths must cross protected preview deployments",
    );
  } finally {
    if (originalBypass === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = originalBypass;
  }

  console.log("batch generate import-only job filtering checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
