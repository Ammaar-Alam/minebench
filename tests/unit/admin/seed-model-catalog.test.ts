import assert from "node:assert/strict";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  getCatalogSeedGenerationModelKeys,
  isCatalogModelGeneratableForSeed,
  modelCatalogSeedUpsertArgs,
  type SeedProviderKeyStatus,
} from "../../../lib/admin/seedModelCatalog";

function providerKeyStatus(overrides: Partial<SeedProviderKeyStatus>): SeedProviderKeyStatus {
  return {
    openai: false,
    anthropic: false,
    gemini: false,
    moonshot: false,
    deepseek: false,
    minimax: false,
    xai: false,
    meta: false,
    zai: false,
    openrouter: false,
    ...overrides,
  };
}

const importedWebHarnessModel = getModelByKey("openai_gpt_4_5_web_harness");
const importedWebHarnessUpsert = modelCatalogSeedUpsertArgs(importedWebHarnessModel, false);

assert.equal(importedWebHarnessUpsert.create.enabled, false);
assert.equal(
  Object.hasOwn(importedWebHarnessUpsert.update, "enabled"),
  false,
  "seed updates should not disable an already-imported import-only model",
);

const regularModel = getModelByKey("anthropic_claude_sonnet_5");
const regularModelUpsert = modelCatalogSeedUpsertArgs(regularModel, false);

assert.equal(
  regularModelUpsert.create.enabled,
  false,
  "seed must create models staged even when the catalog marks them enabled",
);
assert.equal(
  Object.hasOwn(regularModelUpsert.update, "enabled"),
  false,
  "seed updates must not activate a staged model; publish verification owns activation",
);

const retiredModel = getModelByKey("gemini_3_0_pro");
assert.equal(retiredModel.enabled, false);
const retiredModelUpsert = modelCatalogSeedUpsertArgs(retiredModel, false);
assert.equal(
  retiredModelUpsert.update.enabled,
  false,
  "seed updates should still retire a model the catalog disabled",
);

const localRegularModelUpsert = modelCatalogSeedUpsertArgs(regularModel, true);
assert.equal(localRegularModelUpsert.create.enabled, true);
assert.equal(
  localRegularModelUpsert.update.enabled,
  true,
  "local seed updates should restore arena eligibility for catalog-enabled models",
);

const localImportedWebHarnessUpsert = modelCatalogSeedUpsertArgs(
  importedWebHarnessModel,
  true,
);
assert.equal(localImportedWebHarnessUpsert.create.enabled, false);
assert.equal(
  Object.hasOwn(localImportedWebHarnessUpsert.update, "enabled"),
  false,
  "local seed updates should preserve an imported model's arena eligibility",
);

const localRetiredModelUpsert = modelCatalogSeedUpsertArgs(retiredModel, true);
assert.equal(localRetiredModelUpsert.create.enabled, false);
assert.equal(
  localRetiredModelUpsert.update.enabled,
  false,
  "local seed updates should preserve the catalog retirement state",
);

const seedGenerationModelKeys = getCatalogSeedGenerationModelKeys([
  regularModel,
  retiredModel,
  importedWebHarnessModel,
]);
assert.equal(seedGenerationModelKeys.includes(regularModel.key), true);
assert.equal(seedGenerationModelKeys.includes(importedWebHarnessModel.key), false);
assert.equal(
  seedGenerationModelKeys.includes(retiredModel.key),
  false,
  "fresh seed generation should select staged catalog models without reviving retired ones",
);

assert.equal(
  isCatalogModelGeneratableForSeed({
    model: importedWebHarnessModel,
    providerKeys: providerKeyStatus({ openai: true, openrouter: true }),
  }),
  false,
  "seed generation should skip import-only models even when provider keys are present",
);
assert.equal(
  isCatalogModelGeneratableForSeed({
    model: regularModel,
    providerKeys: providerKeyStatus({ anthropic: true }),
  }),
  true,
);

const museSpark12 = getModelByKey("meta_muse_spark_1_2");
assert.equal(
  isCatalogModelGeneratableForSeed({
    model: museSpark12,
    providerKeys: providerKeyStatus({ meta: true }),
  }),
  true,
  "Muse Spark 1.2 should be seed-generatable with a direct Meta key",
);
assert.equal(
  isCatalogModelGeneratableForSeed({
    model: museSpark12,
    providerKeys: providerKeyStatus({ openrouter: true }),
  }),
  true,
  "Muse Spark 1.2 should retain OpenRouter fallback for seeding",
);
assert.equal(
  isCatalogModelGeneratableForSeed({
    model: museSpark12,
    providerKeys: providerKeyStatus({}),
  }),
  false,
  "Muse Spark 1.2 should be skipped when neither route has a key",
);

const glm53 = getModelByKey("zai_glm_5_3");
assert.equal(
  isCatalogModelGeneratableForSeed({
    model: glm53,
    providerKeys: providerKeyStatus({ zai: true }),
  }),
  true,
  "GLM 5.3 should be seed-generatable with a direct Z.AI key",
);
assert.equal(
  isCatalogModelGeneratableForSeed({
    model: glm53,
    providerKeys: providerKeyStatus({}),
  }),
  false,
  "GLM 5.3 should be skipped when neither route has a key",
);

console.log("seed model catalog checks passed");
