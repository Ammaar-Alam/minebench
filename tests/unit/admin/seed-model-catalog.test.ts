import assert from "node:assert/strict";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  isCatalogModelGeneratableForSeed,
  modelCatalogSeedUpsertArgs,
} from "../../../lib/admin/seedModelCatalog";

const importedWebHarnessModel = getModelByKey("openai_gpt_4_5_web_harness");
const importedWebHarnessUpsert = modelCatalogSeedUpsertArgs(importedWebHarnessModel);

assert.equal(importedWebHarnessUpsert.create.enabled, false);
assert.equal(
  Object.hasOwn(importedWebHarnessUpsert.update, "enabled"),
  false,
  "seed updates should not disable an already-imported import-only model",
);

const regularModel = getModelByKey("anthropic_claude_sonnet_5");
const regularModelUpsert = modelCatalogSeedUpsertArgs(regularModel);

assert.equal(regularModelUpsert.create.enabled, true);
assert.equal(regularModelUpsert.update.enabled, true);

assert.equal(
  isCatalogModelGeneratableForSeed({
    model: importedWebHarnessModel,
    providerKeys: { openai: true, openrouter: true },
  }),
  false,
  "seed generation should skip import-only models even when provider keys are present",
);
assert.equal(
  isCatalogModelGeneratableForSeed({
    model: regularModel,
    providerKeys: { anthropic: true, openrouter: false },
  }),
  true,
);

console.log("seed model catalog checks passed");
