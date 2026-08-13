import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import {
  moonshotThinkingConfigForModel,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import {
  assertCatalogEntry,
  installFetchCapture,
  jsonResponse,
  runGeneration,
  runProviderConfigTest,
} from "../../helpers/providerConfigHarness";

runProviderConfigTest(
  "moonshot family",
  {
    // Kimi K3's 1M ceiling must clamp requests without an env override raising it
    MINEBENCH_MAX_OUTPUT_TOKENS: undefined,
    MOONSHOT_BASE_URL: "https://moonshot.test",
  },
  async (capture) => {
    let rejectOpenRouterReasoning = false;
    capture.respondWith((request) =>
      rejectOpenRouterReasoning && request.url.includes("openrouter.test")
        ? jsonResponse({ error: { message: "reasoning effort is unsupported" } }, 400)
        : null,
    );

    const model = assertCatalogEntry({
      key: "moonshot_kimi_k3",
      provider: "moonshot",
      modelId: "kimi-k3",
      displayName: "Kimi K3",
      openRouterModelId: "moonshotai/kimi-k3",
      slug: "kimi-k3",
    });
    assert.deepEqual(moonshotThinkingConfigForModel(model.modelId), {
      reasoningEffort: "max",
    });
    assert.throws(() => moonshotThinkingConfigForModel(model.modelId, "disabled"));
    assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!), ["max"]);

    const direct = await runGeneration(capture, {
      modelKey: model.key,
      providerKeys: { moonshot: "test-moonshot-key" },
    });
    const directRequest = direct.requests.find((request) =>
      request.url.includes("moonshot.test"),
    )?.body;
    assert.ok(directRequest);
    assert.equal(directRequest.model, "kimi-k3");
    assert.equal(directRequest.max_completion_tokens, 1_048_576);
    assert.equal(directRequest.reasoning_effort, "max");
    assert.equal("thinking" in directRequest, false);
    assert.equal("temperature" in directRequest, false);
    assert.equal("top_p" in directRequest, false);
    assert.equal(
      (directRequest.response_format as { json_schema?: { strict?: unknown } })?.json_schema
        ?.strict,
      true,
    );

    const openRouter = await runGeneration(capture, {
      modelKey: model.key,
      providerKeys: { openrouter: "test-openrouter-key" },
    });
    const openRouterRequest = openRouter.requests.find((request) =>
      request.url.includes("openrouter.test"),
    )?.body;
    assert.ok(openRouterRequest);
    assert.equal(openRouterRequest.model, "moonshotai/kimi-k3");
    assert.equal(openRouterRequest.max_tokens, 1_048_576);
    assert.deepEqual(openRouterRequest.reasoning, { effort: "max" });
    assert.equal("temperature" in openRouterRequest, false);
    assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
    const responseFormat = openRouterRequest.response_format as {
      type?: unknown;
      json_schema?: { name?: unknown; strict?: unknown; schema?: unknown };
    };
    assert.equal(responseFormat.type, "json_schema");
    assert.equal(responseFormat.json_schema?.name, "voxel_build_response");
    assert.equal(responseFormat.json_schema?.strict, true);
    assert.ok(responseFormat.json_schema?.schema);

    // An env override above the model ceiling still clamps to the ceiling
    process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "2000000";
    const capped = await runGeneration(capture, {
      modelKey: model.key,
      providerKeys: { moonshot: "test-moonshot-key" },
    });
    const cappedDirect = capped.requests[0]?.body;
    assert.ok(cappedDirect);
    assert.equal(cappedDirect.max_completion_tokens, 1_048_576);
    delete process.env.MINEBENCH_MAX_OUTPUT_TOKENS;

    // Kimi K3 has a single effort, so an effort rejection is terminal
    rejectOpenRouterReasoning = true;
    const rejectedStart = capture.requests.length;
    const originalConsoleError = console.error;
    console.error = () => {};
    let rejected;
    try {
      rejected = await generateVoxelBuild({
        modelKey: model.key,
        prompt: "small tower",
        gridSize: 64,
        palette: "simple",
        enableTools: false,
        maxAttempts: 1,
        providerKeys: { openrouter: "test-openrouter-key" },
        allowServerKeys: false,
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(rejected.ok, false);
    const rejectedRequests = capture.requests
      .slice(rejectedStart)
      .filter((request) => request.url.includes("openrouter.test"));
    assert.equal(rejectedRequests.length, 1);
    assert.deepEqual(rejectedRequests[0]?.body.reasoning, { effort: "max" });
  },
);
