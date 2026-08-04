import assert from "node:assert/strict";

import { MODEL_CATALOG } from "../../../lib/ai/modelCatalog";
import {
  modelOutputCeiling,
  modelUsesDefaultSampling,
} from "../../../lib/ai/modelRequestProfiles";

// A ceiling belongs to the model, so both routes resolve the same number
for (const [direct, routed] of [
  ["kimi-k3", "moonshotai/kimi-k3"],
  ["grok-4.5", "x-ai/grok-4.5"],
  ["deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
  ["qwen3.8-max", "qwen/qwen3.8-max"],
  ["gemini-3.6-flash", "google/gemini-3.6-flash"],
] as const) {
  assert.equal(
    modelOutputCeiling(direct),
    modelOutputCeiling(routed),
    `${routed} should share the ceiling of ${direct}`,
  );
}

assert.equal(modelOutputCeiling("kimi-k3"), 1_048_576);
assert.equal(modelOutputCeiling("grok-4.3"), 1_000_000);
assert.equal(modelOutputCeiling("claude-opus-5"), 128_000);
assert.equal(modelOutputCeiling("qwen3.8-max"), 131_072);
assert.equal(modelOutputCeiling("qwen/qwen3.8-max"), 131_072);
assert.equal(modelOutputCeiling("MiniMax-M2.7"), 131_072);
assert.equal(modelOutputCeiling("grok-4-1-fast"), 30_000);

// A model with no declared ceiling runs on the MineBench default
assert.equal(modelOutputCeiling("gpt-4o"), undefined);
assert.equal(modelOutputCeiling("claude-opus-4-6"), undefined);

// GPT-5 raises the direct budget because the native ceiling covers reasoning
// plus output, while OpenRouter counts visible output alone
assert.equal(modelOutputCeiling("gpt-5.4"), 128_000);
assert.equal(modelOutputCeiling("gpt-5-pro"), 272_000);
assert.equal(modelOutputCeiling("openai/gpt-5.4"), undefined);

assert.equal(modelUsesDefaultSampling("kimi-k3"), true);
assert.equal(modelUsesDefaultSampling("gpt-5.6-sol"), true);
assert.equal(modelUsesDefaultSampling("claude-opus-5"), true);
assert.equal(modelUsesDefaultSampling("anthropic/claude-opus-4.8"), true);
assert.equal(modelUsesDefaultSampling("gpt-4o"), false);
assert.equal(modelUsesDefaultSampling("claude-sonnet-4-6"), false);

// Lookups are case-insensitive so a catalog entry's own casing cannot change the
// resolved request, as MiniMax-M2.7 mixes case
assert.equal(modelOutputCeiling("minimax-m2.7"), modelOutputCeiling("MiniMax-M2.7"));
assert.equal(modelUsesDefaultSampling("KIMI-K3"), modelUsesDefaultSampling("kimi-k3"));

// Every catalogued ID must resolve without throwing, and a declared ceiling has
// to be a usable positive budget
for (const model of MODEL_CATALOG) {
  for (const modelId of [model.modelId, model.openRouterModelId].filter(
    (id): id is string => typeof id === "string",
  )) {
    const ceiling = modelOutputCeiling(modelId);
    if (ceiling === undefined) continue;
    assert.ok(
      Number.isInteger(ceiling) && ceiling > 0,
      `${modelId} should declare a positive integer output ceiling`,
    );
  }
}

console.log("model request profile checks passed");
