import assert from "node:assert/strict";
import { resolveSavedGenerationModel } from "../../../lib/generations/model";

async function main() {
const direct = await resolveSavedGenerationModel(
  { id: "one", kind: "catalog", modelKey: "openai_gpt_5_4_mini" },
  { openai: "direct-key", openrouter: "router-key" },
);
assert.equal(direct.credential.provider, "openai");
assert.equal(direct.credential.value, "direct-key");
assert.equal(direct.modelKind, "catalog");

const routed = await resolveSavedGenerationModel(
  { id: "one", kind: "catalog", modelKey: "openai_gpt_5_4_mini" },
  { openrouter: "router-key" },
);
assert.equal(routed.credential.provider, "openrouter");
assert.equal(routed.preferOpenRouter, true);

const custom = await resolveSavedGenerationModel(
  {
    id: "custom",
    kind: "custom",
    provider: "custom",
    displayName: "Local model",
    modelId: "local-1",
    baseUrl: "https://models.example.test/v1/chat/completions",
    headers: { "User-Agent": "claude-cli/2.1.179" },
    body: { thinking: { type: "enabled" }, max_tokens: 128_000 },
  },
  { custom: "custom-key", openrouter: "unused-key" },
  { assertSafeCustomApiUrl: async () => undefined },
);
assert.equal(custom.modelKind, "custom");
assert.equal(custom.credential.provider, "custom");
assert.equal(custom.customBaseUrl, "https://models.example.test/v1/chat/completions");
assert.deepEqual(custom.customHeaders, { "User-Agent": "claude-cli/2.1.179" });
assert.deepEqual(custom.customBody, {
  thinking: { type: "enabled" },
  max_tokens: 128_000,
});

const openRouter = await resolveSavedGenerationModel(
  {
    id: "unlisted",
    kind: "custom",
    provider: "openrouter",
    displayName: "Vendor model",
    modelId: "vendor/model",
  },
  { openrouter: "router-key" },
);
assert.equal(openRouter.modelKind, "openrouter");
assert.equal(openRouter.openRouterModelId, "vendor/model");
assert.equal(openRouter.preferOpenRouter, false);

const meta = await resolveSavedGenerationModel(
  { id: "meta", kind: "catalog", modelKey: "meta_muse_spark_1_2" },
  { meta: "meta-key" },
);
assert.equal(meta.credential.provider, "meta");
assert.equal(meta.credential.value, "meta-key");

const zai = await resolveSavedGenerationModel(
  { id: "zai", kind: "catalog", modelKey: "zai_glm_5_3" },
  { zai: "zai-key" },
);
assert.equal(zai.credential.provider, "zai");
assert.equal(zai.credential.value, "zai-key");

await assert.rejects(
  () => resolveSavedGenerationModel(
    { id: "one", kind: "catalog", modelKey: "openai_gpt_5_4_mini" },
    {},
  ),
  /missing_provider_key/,
);

console.log("saved generation model checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
