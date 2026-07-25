import assert from "node:assert/strict";

import { claudeCapabilities, isKnownClaudeRelease } from "../../../lib/ai/claudeModels";
import { MODEL_CATALOG } from "../../../lib/ai/modelCatalog";

// Effort ladders are declared per release rather than derived from the version,
// because Anthropic has changed them mid-generation
assert.deepEqual(claudeCapabilities("claude-opus-5").effortLadder, [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
]);
assert.deepEqual(claudeCapabilities("claude-opus-4-6").effortLadder, [
  "max",
  "high",
  "medium",
  "low",
]);
assert.deepEqual(claudeCapabilities("claude-opus-4-5").effortLadder, []);
assert.equal(claudeCapabilities("claude-opus-4-6").adaptiveThinking, true);
assert.equal(claudeCapabilities("claude-opus-4-5").adaptiveThinking, false);

// Only Opus dropped sampling controls before the 5 generation
assert.equal(claudeCapabilities("claude-sonnet-4-6").defaultSamplingOnly, false);
assert.equal(claudeCapabilities("claude-opus-4-7").defaultSamplingOnly, true);
assert.equal(claudeCapabilities("claude-sonnet-5").defaultSamplingOnly, true);

// Only 4.5 still requests an explicit thinking budget
assert.equal(claudeCapabilities("claude-opus-4-5").legacyManualThinking, true);
assert.equal(claudeCapabilities("claude-sonnet-4-5").legacyManualThinking, true);
assert.equal(claudeCapabilities("claude-opus-4-6").legacyManualThinking, false);

// The 1M beta header applies to the 4.6 pair and Sonnet 4.5 only
assert.equal(claudeCapabilities("claude-opus-4-6").context1mBeta, true);
assert.equal(claudeCapabilities("claude-sonnet-4-5").context1mBeta, true);
assert.equal(claudeCapabilities("claude-opus-5").context1mBeta, false);

assert.equal(claudeCapabilities("claude-opus-5").maxOutputTokens, 128_000);
assert.equal(claudeCapabilities("claude-fable-5").maxOutputTokens, 128_000);
assert.equal(claudeCapabilities("claude-opus-4-6").maxOutputTokens, null);

assert.equal(claudeCapabilities("claude-opus-5").effortEnvVar, "ANTHROPIC_OPUS_5_EFFORT");
assert.equal(claudeCapabilities("claude-opus-4-8").effortEnvVar, "ANTHROPIC_OPUS_4_8_EFFORT");
assert.equal(claudeCapabilities("claude-opus-4-5").effortEnvVar, null);

const NOTHING_SUPPORTED = {
  effortLadder: [],
  adaptiveThinking: false,
  defaultSamplingOnly: false,
  legacyManualThinking: false,
  context1mBeta: false,
  maxOutputTokens: null,
  effortEnvVar: null,
};

// An undeclared Claude release must not inherit its predecessor's capabilities.
// A future model may change its output cap or effort levels, so it resolves to
// nothing until someone reads the model card and declares it.
for (const modelId of ["claude-opus-5-1", "claude-opus-6", "claude-sonnet-5-1"]) {
  assert.equal(isKnownClaudeRelease(modelId), false, `${modelId} should not be declared yet`);
  assert.deepEqual(
    claudeCapabilities(modelId),
    NOTHING_SUPPORTED,
    `${modelId} must not inherit capabilities from an earlier release`,
  );
}

// Non-Claude models resolve to nothing so shared predicates that run over every
// model ID stay inert
for (const modelId of ["gpt-5.6-sol", "gemini-3.6-flash", "kimi-k3", "grok-4.5"]) {
  assert.equal(isKnownClaudeRelease(modelId), false);
  assert.deepEqual(claudeCapabilities(modelId), NOTHING_SUPPORTED);
}

// OpenRouter IDs reorder the family, separate versions with a dot, and may carry
// a variant suffix, so they must resolve identically to their direct counterpart
for (const [direct, ...routed] of [
  [
    "claude-opus-4-8",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-4.8-opus",
    "anthropic/claude-opus-4.8:beta",
  ],
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

// Every catalogued Anthropic model must be declared, so adding a model to the
// catalog without recording its capabilities fails here instead of silently
// inheriting an older release's request shape
for (const model of MODEL_CATALOG.filter((entry) => entry.provider === "anthropic")) {
  assert.ok(
    isKnownClaudeRelease(model.modelId),
    `${model.modelId} is in the catalog but not declared in CLAUDE_RELEASES`,
  );
  if (!model.openRouterModelId) continue;
  assert.deepEqual(
    claudeCapabilities(model.openRouterModelId),
    claudeCapabilities(model.modelId),
    `${model.openRouterModelId} should match ${model.modelId}`,
  );
}

console.log("claude capability checks passed");
