import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCandidateModels,
  getImportOnlyModelsForGenerationJobs,
  getJobsToGenerate,
  isEmptyPlaceholder,
} from "../../../scripts/batch-generate";
import type { ModelKey } from "../../../lib/ai/modelCatalog";

function job(modelKey: ModelKey) {
  return { modelKey };
}

async function main() {
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

  console.log("batch generate import-only job filtering checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
