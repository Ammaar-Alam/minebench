import assert from "node:assert/strict";
import { MODEL_CATALOG } from "../../../lib/ai/modelCatalog";
import { selectGenerationProviderKeys } from "../../../lib/ai/providerKeys";

const allKeys = {
  openai: " openai-key ",
  anthropic: "anthropic-key",
  gemini: "gemini-key",
  openrouter: "openrouter-key",
  custom: "custom-key",
};

assert.deepEqual(
  selectGenerationProviderKeys(
    [{ id: "openai", kind: "catalog", modelKey: "openai_gpt_5_4_mini" }],
    allKeys,
  ),
  { openai: "openai-key" },
  "a durable request should include only the direct key selected by its model",
);

assert.deepEqual(
  selectGenerationProviderKeys(
    [
      { id: "openai", kind: "catalog", modelKey: "openai_gpt_5_4_mini" },
      { id: "gemini", kind: "catalog", modelKey: "gemini_3_5_flash" },
    ],
    allKeys,
  ),
  { openai: "openai-key", gemini: "gemini-key" },
  "comparison requests should include one credential for each selected direct provider",
);

assert.deepEqual(
  selectGenerationProviderKeys(
    [{ id: "openai", kind: "catalog", modelKey: "openai_gpt_5_4_mini" }],
    { openrouter: " router-key " },
  ),
  { openrouter: "router-key" },
  "OpenRouter should be included only when it is the selected model route",
);

const forcedOpenRouter = MODEL_CATALOG.find((model) => model.forceOpenRouter);
assert.ok(forcedOpenRouter, "the catalog should retain a forced OpenRouter fixture");
assert.deepEqual(
  selectGenerationProviderKeys(
    [{ id: "forced", kind: "catalog", modelKey: forcedOpenRouter.key }],
    { openrouter: "router-key", [forcedOpenRouter.provider]: "unused-direct-key" },
  ),
  { openrouter: "router-key" },
);

assert.deepEqual(
  selectGenerationProviderKeys(
    [{
      id: "custom",
      kind: "custom",
      provider: "custom",
      displayName: "Custom",
      modelId: "custom-model",
      baseUrl: "https://models.example.test/v1/chat/completions",
    }],
    allKeys,
  ),
  { custom: "custom-key" },
);

console.log("selected generation provider key checks passed");
