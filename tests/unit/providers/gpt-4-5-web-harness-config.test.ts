import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

async function main() {
  const model = getModelByKey("openai_gpt_4_5_web_harness");

  assert.equal(model.provider, "openai");
  assert.equal(model.modelId, "gpt-4.5-preview");
  assert.equal(model.displayName, "GPT 4.5 (web harness)");
  assert.equal(model.enabled, false);
  assert.equal(model.importOnly, true);
  assert.equal(model.openRouterModelId, undefined);
  assert.equal(MODEL_SLUG.openai_gpt_4_5_web_harness, "gpt-4-5-web-harness");

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async (): Promise<Response> => {
    fetchCalled = true;
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await generateVoxelBuild({
      modelKey: "openai_gpt_4_5_web_harness",
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      enableTools: false,
      providerKeys: { openai: "test-openai-key" },
      allowServerKeys: false,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /import-only/i);
    assert.match(result.error, /web harness JSON/i);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("gpt 4.5 web harness config checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
