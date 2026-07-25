import assert from "node:assert/strict";

import { claudeCapabilities } from "../../../lib/ai/claudeModels";
import { MODEL_CATALOG } from "../../../lib/ai/modelCatalog";

// Adaptive thinking arrived at 4.6, xhigh effort and the Opus sampling change at
// 4.7, and the 5 generation applies both across every family
assert.equal(claudeCapabilities("claude-opus-4-5").adaptiveThinking, false);
assert.equal(claudeCapabilities("claude-opus-4-6").adaptiveThinking, true);
assert.equal(claudeCapabilities("claude-opus-4-6").xhighEffort, false);
assert.equal(claudeCapabilities("claude-opus-4-7").xhighEffort, true);
assert.equal(claudeCapabilities("claude-sonnet-4-6").defaultSamplingOnly, false);
assert.equal(claudeCapabilities("claude-opus-4-7").defaultSamplingOnly, true);
assert.equal(claudeCapabilities("claude-sonnet-5").defaultSamplingOnly, true);

// Only 4.5 still requests an explicit thinking budget
assert.equal(claudeCapabilities("claude-opus-4-5").legacyManualThinking, true);
assert.equal(claudeCapabilities("claude-sonnet-4-5").legacyManualThinking, true);
assert.equal(claudeCapabilities("claude-opus-4-6").legacyManualThinking, false);

// The 1M beta header applies to Opus 4.6 and the Sonnet 4 line only
assert.equal(claudeCapabilities("claude-opus-4-6").context1mBeta, true);
assert.equal(claudeCapabilities("claude-sonnet-4-5").context1mBeta, true);
assert.equal(claudeCapabilities("claude-opus-5").context1mBeta, false);

// Releases that dropped sampling controls share the 128k Messages API maximum
assert.equal(claudeCapabilities("claude-opus-5").maxOutputTokens, 128_000);
assert.equal(claudeCapabilities("claude-fable-5").maxOutputTokens, 128_000);
assert.equal(claudeCapabilities("claude-opus-4-6").maxOutputTokens, null);

assert.equal(claudeCapabilities("claude-opus-5").effortEnvVar, "ANTHROPIC_OPUS_5_EFFORT");
assert.equal(claudeCapabilities("claude-opus-4-8").effortEnvVar, "ANTHROPIC_OPUS_4_8_EFFORT");
assert.equal(claudeCapabilities("claude-opus-4-5").effortEnvVar, null);

// Non-Claude models must resolve to no capabilities so shared predicates that
// run over every model ID stay inert
for (const modelId of ["gpt-5.6-sol", "gemini-3.6-flash", "kimi-k3", "grok-4.5"]) {
  assert.deepEqual(claudeCapabilities(modelId), {
    adaptiveThinking: false,
    xhighEffort: false,
    defaultSamplingOnly: false,
    legacyManualThinking: false,
    context1mBeta: false,
    maxOutputTokens: null,
    effortEnvVar: null,
  });
}

// OpenRouter IDs reorder the family, separate versions with a dot, and may carry
// a variant suffix, so they must resolve identically to their direct counterpart
for (const [direct, ...routed] of [
  ["claude-opus-4-8", "anthropic/claude-opus-4.8", "anthropic/claude-4.8-opus", "anthropic/claude-opus-4.8:beta"],
  ["claude-opus-5", "anthropic/claude-opus-5"],
  ["claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"],
] as const) {
  for (const routedId of routed) {
    assert.deepEqual(
      claudeCapabilities(routedId),
      claudeCapabilities(direct),
      `${routedId} should resolve the same capabilities as ${direct}`,
    );
  }
}

// Every catalogued Anthropic model must resolve, so a new entry cannot silently
// fall back to the no-capability default
for (const model of MODEL_CATALOG.filter((entry) => entry.provider === "anthropic")) {
  const capabilities = claudeCapabilities(model.modelId);
  assert.ok(
    capabilities.adaptiveThinking || capabilities.legacyManualThinking,
    `${model.modelId} should resolve a thinking mode`,
  );
  if (!model.openRouterModelId) continue;
  assert.deepEqual(
    claudeCapabilities(model.openRouterModelId),
    capabilities,
    `${model.openRouterModelId} should match ${model.modelId}`,
  );
}

console.log("claude capability checks passed");
