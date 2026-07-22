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
assert.equal(gpt56.averageInferenceTime, "25m 16.2s (1,516.2s)");
assert.equal(gpt56.totalCost, "$710.82");
assert.equal(gpt56.buildCount, 15);

const gemini36Flash = getModelBenchmarkProfile("gemini_3_6_flash");
assert.equal(gemini36Flash?.sourceRelease, "3.10.0 draft");
assert.equal(gemini36Flash?.averageInferenceTime, "1m 41.9s (101.9s)");
assert.equal(gemini36Flash?.totalCost, undefined);
assert.equal(gemini36Flash?.buildCount, 15);

const gemini35FlashLite = getModelBenchmarkProfile("gemini_3_5_flash_lite");
assert.equal(gemini35FlashLite?.sourceRelease, "3.10.0 draft");
assert.equal(gemini35FlashLite?.averageInferenceTime, "25.7s");
assert.equal(gemini35FlashLite?.totalCost, undefined);
assert.equal(gemini35FlashLite?.buildCount, 15);

const fable5 = getModelBenchmarkProfile("anthropic_claude_fable_5");
assert.equal(fable5?.averageInferenceTime, "18m 04.4s (1,084.4s)");
assert.equal(fable5?.totalCost, "$54.93");
assert.equal(fable5?.buildCount, 15);

const opus48 = getModelBenchmarkProfile("anthropic_claude_4_8_opus");
assert.equal(opus48?.averageInferenceTime, "24m 47.9s (1,487.9s)");
assert.equal(opus48?.totalCost, "$41.52");
assert.equal(opus48?.buildCount, 15);

const gpt55 = getModelBenchmarkProfile("openai_gpt_5_5");
assert.equal(gpt55?.averageInferenceTime, "10m 24s (624s)");
assert.equal(gpt55?.totalCost, "$19.98");

const gpt55Pro = getModelBenchmarkProfile("openai_gpt_5_5_pro");
assert.equal(gpt55Pro?.averageInferenceTime, "21m 23.3s (1,283.3s)");
assert.equal(gpt55Pro?.totalCost, "$223.90");

const gpt54Pro = getModelBenchmarkProfile("openai_gpt_5_4_pro");
assert.deepEqual(gpt54Pro?.parameters, [
  { label: "Reasoning effort", value: "XHigh" },
  { label: "Text verbosity", value: "High" },
  { label: "Output cap", value: "128,000 tokens" },
]);
assert.equal(gpt54Pro?.averageInferenceTime, "56 minutes");
assert.equal(gpt54Pro?.totalCost, "$435");

const gpt54 = getModelBenchmarkProfile("openai_gpt_5_4");
assert.equal(gpt54?.averageInferenceTime, undefined);
assert.equal(gpt54?.totalCost, "~$25");

const gpt53Codex = getModelBenchmarkProfile("openai_gpt_5_3_codex");
assert.deepEqual(gpt53Codex?.parameters, [
  { label: "Reasoning effort", value: "XHigh" },
  { label: "Output cap", value: "128,000 tokens" },
]);
assert.equal(gpt53Codex?.averageInferenceTime, undefined);
assert.equal(gpt53Codex?.totalCost, "Under approximately $5");

const opus47 = getModelBenchmarkProfile("anthropic_claude_4_7_opus");
assert.equal(opus47?.averageInferenceTime, "~43m 20s (~2,600s)");
assert.equal(opus47?.totalCost, "~$275");

const opus46 = getModelBenchmarkProfile("anthropic_claude_4_6_opus");
assert.equal(opus46?.averageInferenceTime, undefined);
assert.equal(opus46?.totalCost, "~$22");

const kimi26 = getModelBenchmarkProfile("moonshot_kimi_k2_6");
assert.equal(kimi26?.averageInferenceTime, undefined);
assert.equal(kimi26?.totalCost, "$2.35");

const gpt45WebHarness = getModelBenchmarkProfile("openai_gpt_4_5_web_harness");
assert.deepEqual(gpt45WebHarness?.parameters, [
  { label: "Source", value: "ChatGPT web harness" },
]);
assert.equal(
  gpt45WebHarness?.note,
  "Imported from the web harness; not directly comparable to API-generated runs.",
);

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

const catalogKeys = MODEL_CATALOG.map((model) => model.key);
assert.equal(
  new Set(catalogKeys).size,
  catalogKeys.length,
  "model catalog keys should be unique",
);
assert.deepEqual(
  Object.keys(MODEL_BENCHMARK_PROFILES).sort(),
  [...catalogKeys].sort(),
  "every catalog model should have exactly one benchmark profile",
);

for (const model of MODEL_CATALOG) {
  const profile = getModelBenchmarkProfile(model.key);
  assert.ok(profile, `${model.key} should have benchmark details`);
  assert.ok(profile.parameters.length > 0, `${model.key} should have run parameters`);

  const labels = profile.parameters.map((parameter) => {
    assert.ok(parameter.label.trim(), `${model.key} parameter labels should not be blank`);
    assert.ok(parameter.value.trim(), `${model.key} parameter values should not be blank`);
    return parameter.label;
  });
  assert.equal(
    new Set(labels).size,
    labels.length,
    `${model.key} parameter labels should be unique`,
  );
}

assert.deepEqual(getModelBenchmarkProfile("gemini_3_1_pro")?.parameters, [
  { label: "Thinking level", value: "High" },
]);
assert.equal(
  Boolean(
    getModelBenchmarkProfile("openai_gpt_5_4")?.averageInferenceTime ||
      getModelBenchmarkProfile("openai_gpt_5_4")?.totalCost,
  ),
  true,
  "a cost-only profile should count as having recorded statistics",
);
assert.equal(
  Boolean(gpt45WebHarness?.averageInferenceTime || gpt45WebHarness?.totalCost),
  false,
  "the web-harness profile should use the historical statistics fallback",
);

console.log("model benchmark profile checks passed");
