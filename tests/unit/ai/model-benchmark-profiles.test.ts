import assert from "node:assert/strict";
import {
  MODEL_BENCHMARK_PROFILES,
  getModelBenchmarkProfile,
} from "../../../lib/ai/modelBenchmarkProfiles";
import {
  MODEL_CATALOG,
  resolveModelDisplayName,
} from "../../../lib/ai/modelCatalog";

const gpt56 = getModelBenchmarkProfile("openai_gpt_5_6_sol");
assert.ok(gpt56, "GPT 5.6 Sol Pro should have verified benchmark details");
assert.deepEqual(gpt56.parameters, [
  { label: "Reasoning mode", value: "Pro" },
  { label: "Reasoning effort", value: "Max" },
  { label: "Text verbosity", value: "High" },
  { label: "Combined reasoning/output cap", value: "128,000 tokens" },
]);
assert.equal(gpt56.sourceRelease, "3.9.0");
assert.equal(gpt56.averageInferenceTime, "25m 16s (1516.2s)");
assert.equal(gpt56.totalCost, "$710.82");
assert.equal(gpt56.buildCount, 15);

assert.equal(
  resolveModelDisplayName("openai_gpt_5_6_sol", "stale database label"),
  "GPT 5.6 Sol Pro",
  "public responses should prefer the canonical catalog label",
);
assert.equal(
  resolveModelDisplayName("unknown_model", "Imported model"),
  "Imported model",
  "unknown persisted models should keep their database label",
);

for (const key of Object.keys(MODEL_BENCHMARK_PROFILES)) {
  assert.ok(
    MODEL_CATALOG.some((model) => model.key === key),
    `benchmark profile ${key} should match a catalog model`,
  );
}

console.log("model benchmark profile checks passed");
