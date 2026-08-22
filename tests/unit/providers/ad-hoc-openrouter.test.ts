import assert from "node:assert/strict";

import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { runProviderConfigTest } from "../../helpers/providerConfigHarness";

runProviderConfigTest("ad hoc OpenRouter", {}, async (capture) => {
  const modelId = "stealth/ox-alpha";
  const result = await generateVoxelBuild({
    model: {
      key: "openrouter",
      provider: "custom",
      modelId,
      displayName: modelId,
      openRouterModelId: modelId,
      forceOpenRouter: true,
      requireStructuredOutput: true,
    },
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    maxOutputTokens: 4096,
    enableTools: false,
    providerKeys: { openrouter: 'Bearer "test-openrouter-key"' },
    allowServerKeys: false,
  });

  assert.equal(result.providerRoute, "openrouter");
  assert.equal(capture.requests.length, 1);
  const request = capture.requests[0];
  assert.equal(request.url, "https://openrouter.test/api/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer test-openrouter-key");
  assert.equal(request.body.model, modelId);
  assert.equal(request.body.max_tokens, 4096);
  assert.deepEqual(request.body.provider, { require_parameters: true });
  assert.equal(
    (request.body.response_format as { type?: unknown })?.type,
    "json_schema",
  );
  assert.equal(
    (request.body.response_format as { json_schema?: { strict?: unknown } })
      ?.json_schema?.strict,
    true,
  );

  const plainTextStart = capture.requests.length;
  await generateVoxelBuild({
    model: {
      key: "openrouter-plain-text",
      provider: "custom",
      modelId,
      displayName: modelId,
      openRouterModelId: modelId,
      forceOpenRouter: true,
      requireStructuredOutput: false,
    },
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    maxOutputTokens: 4096,
    enableTools: false,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
  });
  const plainTextRequest = capture.requests[plainTextStart];
  assert.ok(plainTextRequest);
  assert.equal(Object.hasOwn(plainTextRequest.body, "provider"), false);
  assert.equal(Object.hasOwn(plainTextRequest.body, "response_format"), false);

  const requestCount = capture.requests.length;
  const customResult = await generateVoxelBuild({
    model: {
      key: "custom",
      provider: "custom",
      modelId: "custom-model",
      displayName: "Custom model",
      baseUrl: "https://api.example.test/v1/chat/completions",
    },
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
  });

  assert.equal(customResult.ok, false);
  assert.match(customResult.error, /Missing custom API key/);
  assert.equal(
    capture.requests.length,
    requestCount,
    "A separate OpenAI-compatible server must not reuse the OpenRouter key",
  );
});
