import assert from "node:assert/strict";
import { getImportOnlyModelsForGenerationJobs } from "../../../scripts/batch-generate";
import type { ModelKey } from "../../../lib/ai/modelCatalog";

function job(modelKey: ModelKey) {
  return { modelKey };
}

async function main() {
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
