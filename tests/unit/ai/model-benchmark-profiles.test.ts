import assert from "node:assert/strict";
import {
  HISTORICAL_BENCHMARK_OUTPUT_CAPS,
  MODEL_BENCHMARK_PROFILES,
  getModelBenchmarkProfile,
  resolveBenchmarkOutputCap,
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
]);
assert.deepEqual(gpt56.outputCap, { kind: "exact", tokens: 128_000 });
assert.equal(gpt56.sourceRelease, "3.9.0");
assert.deepEqual(gpt56.averageInference, { milliseconds: 1_516_200 });
assert.ok(
  Number.isInteger(gpt56.averageJsonSizeBytes) && (gpt56.averageJsonSizeBytes ?? 0) > 0,
  "GPT 5.6 Sol Pro should use the generated exact JSON-size aggregate",
);
assert.deepEqual(gpt56.totalCost, { usd: 710.82 });
assert.equal(gpt56.buildCount, 15);

assert.equal(
  resolveBenchmarkOutputCap("openai_gpt_5_6_sol", {
    expectedBuildCount: 15,
    finalizedBuildCount: 15,
    inferenceSampleCount: 15,
    configurationSampleCount: 0,
    configurationIsConsistent: false,
  }).kind,
  "exact",
  "complete historical timing without cap telemetry should keep GPT 5.6's known cap",
);
assert.deepEqual(
  resolveBenchmarkOutputCap("openai_gpt_5_6_sol", {
    expectedBuildCount: 15,
    finalizedBuildCount: 15,
    inferenceSampleCount: 15,
    configurationSampleCount: 15,
    configurationIsConsistent: false,
    outputCapSampleCount: 0,
    outputCapIsConsistent: false,
  }),
  { kind: "unavailable", reason: "accepted-cap-unrecorded" },
  "complete current configuration telemetry should not masquerade as a pre-tracking cap",
);
assert.deepEqual(
  resolveBenchmarkOutputCap("openai_gpt_5_6_sol", {
    expectedBuildCount: 15,
    finalizedBuildCount: 15,
    inferenceSampleCount: 15,
    configurationSampleCount: 15,
    configurationIsConsistent: false,
    outputCapSampleCount: 15,
    outputCapIsConsistent: true,
    outputCapTokens: 64_000,
  }),
  { kind: "exact", tokens: 64_000 },
  "one consistent accepted cap should replace history despite other configuration differences",
);
assert.deepEqual(
  resolveBenchmarkOutputCap("openai_gpt_5_6_sol", {
    expectedBuildCount: 15,
    finalizedBuildCount: 15,
    inferenceSampleCount: 15,
    configurationSampleCount: 15,
    configurationIsConsistent: false,
    outputCapSampleCount: 15,
    outputCapIsConsistent: false,
  }),
  { kind: "unavailable", reason: "varied-across-builds" },
  "a complete mixed-cap cohort should not fall back to a single historical cap",
);

const gemini36Flash = getModelBenchmarkProfile("gemini_3_6_flash");
assert.equal(gemini36Flash?.sourceRelease, "3.10.0");
assert.deepEqual(gemini36Flash?.averageInference, { milliseconds: 101_900 });
assert.deepEqual(gemini36Flash?.totalCost, { usd: 2.84 });
assert.equal(gemini36Flash?.buildCount, 15);

const gemini35FlashLite = getModelBenchmarkProfile("gemini_3_5_flash_lite");
assert.equal(gemini35FlashLite?.sourceRelease, "3.10.0");
assert.deepEqual(gemini35FlashLite?.averageInference, { milliseconds: 25_700 });
assert.deepEqual(gemini35FlashLite?.totalCost, { usd: 0.38 });
assert.equal(gemini35FlashLite?.buildCount, 15);

const gemini30Flash = getModelBenchmarkProfile("gemini_3_0_flash");
assert.deepEqual(gemini30Flash?.outputCap, { kind: "exact", tokens: 65_536 });

const fable5 = getModelBenchmarkProfile("anthropic_claude_fable_5");
assert.deepEqual(fable5?.averageInference, { milliseconds: 1_084_400 });
assert.deepEqual(fable5?.totalCost, { usd: 54.93 });
assert.equal(fable5?.buildCount, 15);

const opus48 = getModelBenchmarkProfile("anthropic_claude_4_8_opus");
assert.deepEqual(opus48?.averageInference, { milliseconds: 1_487_900 });
assert.deepEqual(opus48?.totalCost, { usd: 41.52 });
assert.equal(opus48?.buildCount, 15);

const gpt55 = getModelBenchmarkProfile("openai_gpt_5_5");
assert.deepEqual(gpt55?.averageInference, { milliseconds: 624_000 });
assert.deepEqual(gpt55?.totalCost, { usd: 19.98 });

const gpt55Pro = getModelBenchmarkProfile("openai_gpt_5_5_pro");
assert.deepEqual(gpt55Pro?.averageInference, { milliseconds: 1_283_300 });
assert.deepEqual(gpt55Pro?.totalCost, { usd: 223.9 });

const gpt54Pro = getModelBenchmarkProfile("openai_gpt_5_4_pro");
assert.deepEqual(gpt54Pro?.parameters, [
  { label: "Reasoning effort", value: "XHigh" },
  { label: "Text verbosity", value: "High" },
]);
assert.deepEqual(gpt54Pro?.outputCap, { kind: "exact", tokens: 128_000 });
assert.deepEqual(gpt54Pro?.averageInference, { milliseconds: 3_360_000 });
assert.deepEqual(gpt54Pro?.totalCost, { usd: 435 });

const gpt54 = getModelBenchmarkProfile("openai_gpt_5_4");
assert.equal(gpt54?.averageInference, undefined);
assert.equal(gpt54?.totalCost, undefined);

const gpt53Codex = getModelBenchmarkProfile("openai_gpt_5_3_codex");
assert.deepEqual(gpt53Codex?.parameters, [
  { label: "Reasoning effort", value: "XHigh" },
]);
assert.deepEqual(gpt53Codex?.outputCap, { kind: "exact", tokens: 128_000 });
assert.equal(gpt53Codex?.averageInference, undefined);
assert.equal(gpt53Codex?.totalCost, undefined);

const grok420 = getModelBenchmarkProfile("xai_grok_4_20");
assert.deepEqual(grok420?.averageInference, { milliseconds: 149_000 });

const opus47 = getModelBenchmarkProfile("anthropic_claude_4_7_opus");
assert.deepEqual(opus47?.averageInference, {
  milliseconds: 2_600_000,
});
assert.equal(opus47?.totalCost, undefined);

const opus46 = getModelBenchmarkProfile("anthropic_claude_4_6_opus");
assert.equal(opus46?.averageInference, undefined);
assert.equal(opus46?.totalCost, undefined);

const kimi26 = getModelBenchmarkProfile("moonshot_kimi_k2_6");
assert.equal(kimi26?.averageInference, undefined);
assert.deepEqual(kimi26?.totalCost, { usd: 2.35 });

const glm51 = getModelBenchmarkProfile("zai_glm_5_1");
assert.deepEqual(
  glm51?.averageInference,
  { milliseconds: 1_046_000 },
  "GLM 5.1's reported 17m 26s is exact",
);

assert.equal(
  getModelBenchmarkProfile("moonshot_kimi_k3")?.sourceRelease,
  "3.10.0",
  "release workflow state should not appear in user-facing version metadata",
);

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

const reconstructedExactOutputCaps = {
  openai_gpt_4_1: 32_768,
  openai_gpt_4o: 16_384,
  anthropic_claude_4_5_sonnet: 32_768,
  qwen_qwen3_max_thinking: 32_768,
  qwen_qwen3_5_397b_a17b: 32_768,
  gemini_3_1_pro: 65_536,
  gemini_2_5_pro: 65_536,
  gemma_4_31b: 32_768,
  moonshot_kimi_k2: 65_536,
  zai_glm_4_7: 65_536,
  minimax_m2_5: 131_072,
} as const;
for (const [modelKey, tokens] of Object.entries(reconstructedExactOutputCaps)) {
  assert.deepEqual(
    HISTORICAL_BENCHMARK_OUTPUT_CAPS[
      modelKey as keyof typeof reconstructedExactOutputCaps
    ],
    { kind: "exact", tokens },
    `${modelKey} should expose its reconstructed accepted cap`,
  );
}
assert.deepEqual(
  HISTORICAL_BENCHMARK_OUTPUT_CAPS.anthropic_claude_4_5_opus,
  { kind: "variants", tokens: [8_192, 32_768] },
);
assert.deepEqual(
  HISTORICAL_BENCHMARK_OUTPUT_CAPS.anthropic_claude_4_6_sonnet,
  { kind: "variants", tokens: [32_768, 64_000] },
);
assert.deepEqual(
  HISTORICAL_BENCHMARK_OUTPUT_CAPS.moonshot_kimi_k2_5,
  { kind: "unavailable", reason: "accepted-cap-unrecorded" },
);
assert.deepEqual(
  HISTORICAL_BENCHMARK_OUTPUT_CAPS.meta_llama_4_maverick,
  { kind: "unavailable", reason: "accepted-cap-unrecorded" },
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
  assert.ok(
    labels.every(
      (label) =>
        !/requested output|accepted output|combined reasoning\/output|completion ceiling|output cap/i.test(
          label,
        ),
    ),
    `${model.key} should keep the normalized output cap outside free-form parameters`,
  );
  if (profile.outputCap.kind === "exact") {
    assert.ok(
      Number.isInteger(profile.outputCap.tokens) && profile.outputCap.tokens > 0,
      `${model.key} output cap should be a positive integer`,
    );
  } else if (profile.outputCap.kind === "variants") {
    assert.ok(
      profile.outputCap.tokens.length > 1 &&
        profile.outputCap.tokens.every(
          (tokens) => Number.isInteger(tokens) && tokens > 0,
        ),
      `${model.key} output cap variants should be positive integers`,
    );
  }
  assert.ok(
    Number.isInteger(profile.averageJsonSizeBytes) && (profile.averageJsonSizeBytes ?? 0) > 0,
    `${model.key} should have a generated average JSON size for its finalized cohort`,
  );
}

assert.deepEqual(getModelBenchmarkProfile("gemini_3_1_pro")?.parameters, [
  { label: "Thinking level", value: "High" },
]);
assert.equal(
  Boolean(
    getModelBenchmarkProfile("openai_gpt_5_4")?.averageInference ||
      getModelBenchmarkProfile("openai_gpt_5_4")?.totalCost,
  ),
  false,
  "removed non-exact GPT 5.4 statistics should remain untracked",
);
assert.equal(
  Boolean(gpt45WebHarness?.averageInference || gpt45WebHarness?.totalCost),
  false,
  "the web-harness profile should keep all benchmark statistics untracked",
);

console.log("model benchmark profile checks passed");
