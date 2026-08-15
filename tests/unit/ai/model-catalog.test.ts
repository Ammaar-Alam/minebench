import assert from "node:assert/strict";
import { MODEL_CATALOG } from "../../../lib/ai/modelCatalog";
import { MODEL_KEY_BY_SLUG, MODEL_SLUG } from "../../../scripts/uploadsCatalog";

// Catalog identity invariants: every key and slug is unique, and no model ID
// collides with another entry's ID in either route namespace. A model may use
// the same ID for its direct and OpenRouter routes (forceOpenRouter entries).

const keys = new Set<string>();
const slugs = new Set<string>();

for (const model of MODEL_CATALOG) {
  assert.ok(!keys.has(model.key), `duplicate model key: ${model.key}`);
  keys.add(model.key);

  assert.match(model.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `invalid slug: ${model.slug}`);
  assert.ok(!slugs.has(model.slug), `duplicate model slug: ${model.slug}`);
  slugs.add(model.slug);
}

for (const model of MODEL_CATALOG) {
  for (const other of MODEL_CATALOG) {
    if (other.key === model.key) continue;
    assert.notEqual(
      model.modelId,
      other.modelId,
      `model ID ${model.modelId} is shared by ${model.key} and ${other.key}`,
    );
    assert.notEqual(
      model.modelId,
      other.openRouterModelId,
      `${model.key}'s direct ID collides with ${other.key}'s OpenRouter ID`,
    );
    if (model.openRouterModelId !== undefined) {
      assert.notEqual(
        model.openRouterModelId,
        other.openRouterModelId,
        `OpenRouter ID ${model.openRouterModelId} is shared by ${model.key} and ${other.key}`,
      );
    }
  }
}

assert.equal(Object.keys(MODEL_SLUG).length, MODEL_CATALOG.length);
for (const model of MODEL_CATALOG) {
  assert.equal(MODEL_SLUG[model.key], model.slug);
  assert.equal(MODEL_KEY_BY_SLUG[model.slug], model.key);
}

console.log(`model catalog identity checks passed for ${MODEL_CATALOG.length} models`);
