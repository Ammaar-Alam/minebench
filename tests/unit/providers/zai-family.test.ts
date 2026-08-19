import assert from "node:assert/strict";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import {
  modelRequiresReasoning,
  openRouterReasoningEffortAttempts,
  zaiReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import {
  assertCatalogEntry,
  assertTraceLine,
  runGeneration,
  runProviderConfigTest,
} from "../../helpers/providerConfigHarness";

runProviderConfigTest("zai glm 5.3", {
  ZAI_API_KEY: "test-zai-key",
  ZAI_BASE_URL: "https://zai.test/api/paas/v4",
}, async (capture) => {
  const model = assertCatalogEntry({
    key: "zai_glm_5_3",
    provider: "zai",
    modelId: "glm-5.3",
    displayName: "Z.AI GLM 5.3",
    openRouterModelId: "z-ai/glm-5.3",
    slug: "glm-5-3",
  });
  assert.equal(modelRequiresReasoning(model.modelId), true);
  assert.equal(modelRequiresReasoning(model.openRouterModelId!), true);
  assert.deepEqual(getModelBenchmarkProfile(model.key)?.parameters, [
    { label: "Reasoning effort", value: "Max" },
  ]);
  assert.deepEqual(getModelBenchmarkProfile(model.key)?.totalCost, { usd: 6.42 });

  // Z.AI documents low|high|max and rejects thinking.type=disabled, so max is
  // both the default and the ladder head, and xhigh resolves onto it
  assert.deepEqual(zaiReasoningEffortAttempts(model.modelId), ["max", "high", "low"]);
  assert.deepEqual(zaiReasoningEffortAttempts(model.modelId, "max"), ["max", "high", "low"]);
  assert.deepEqual(zaiReasoningEffortAttempts(model.modelId, "xhigh"), ["max", "high", "low"]);
  assert.deepEqual(zaiReasoningEffortAttempts(model.modelId, "high"), ["high", "low"]);
  assert.deepEqual(zaiReasoningEffortAttempts(model.modelId, "low"), ["low"]);
  assert.throws(
    () => zaiReasoningEffortAttempts(model.modelId, "medium"),
    /Supported values: max, xhigh, high, low\./,
  );
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!), [
    "max",
    "high",
    "low",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!, "high"), [
    "high",
    "low",
  ]);

  const direct = await runGeneration(capture, {
    modelKey: model.key,
    providerKeys: {},
    allowServerKeys: true,
  });
  assert.equal(direct.result.providerRoute, "direct");
  const directRequest = direct.requests.find((request) =>
    request.url.includes("zai.test"),
  );
  assert.ok(directRequest, "Direct Z.AI request should be captured");
  assert.equal(directRequest.url, "https://zai.test/api/paas/v4/chat/completions");
  assert.equal(directRequest.body.model, "glm-5.3");
  assert.equal(directRequest.body.max_tokens, 131_072);
  assert.equal(directRequest.body.reasoning_effort, "max");
  assert.deepEqual(directRequest.body.thinking, { type: "enabled" });
  assert.deepEqual(directRequest.body.response_format, { type: "json_object" });
  assertTraceLine(
    direct.traces,
    ["max_output_tokens=131072", "reasoning_effort=max"],
    "Direct trace should report the 131072-token cap and max reasoning effort",
  );

  const openRouter = await runGeneration(capture, {
    modelKey: model.key,
    providerKeys: { openrouter: "test-openrouter-key" },
    preferOpenRouter: true,
  });
  const openRouterRequest = openRouter.requests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(openRouterRequest, "OpenRouter request should be captured");
  assert.equal(openRouterRequest.model, "z-ai/glm-5.3");
  assert.equal(openRouterRequest.max_tokens, 131_072);
  assert.deepEqual(openRouterRequest.reasoning, { effort: "max" });
  assert.deepEqual(openRouterRequest.response_format, { type: "json_object" });
  assertTraceLine(
    openRouter.traces,
    ["max_output_tokens=131072", "effort_fallback=max->high->low"],
    "OpenRouter trace should report the 131072-token cap and the GLM 5.3 effort ladder",
    ["disabled"],
  );
});

runProviderConfigTest("zai family", {}, async (capture) => {
  const model = assertCatalogEntry({
    key: "zai_glm_5_2",
    provider: "zai",
    modelId: "glm-5.2",
    displayName: "Z.AI GLM 5.2",
    openRouterModelId: "z-ai/glm-5.2",
    slug: "glm-5-2",
    forceOpenRouter: true,
  });
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!), [
    "xhigh",
    "high",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!, "max"), [
    "xhigh",
    "high",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!, "high"), [
    "high",
  ]);

  const openRouter = await runGeneration(capture, {
    modelKey: model.key,
    providerKeys: { openrouter: "test-openrouter-key" },
  });
  const openRouterRequest = openRouter.requests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(openRouterRequest, "OpenRouter request should be captured");
  assert.equal(openRouterRequest.model, "z-ai/glm-5.2");
  assert.equal(openRouterRequest.max_tokens, 131_072);
  assert.deepEqual(openRouterRequest.reasoning, { effort: "xhigh" });
  assertTraceLine(
    openRouter.traces,
    [
      "max_output_tokens=131072",
      "effort_fallback=xhigh->high->disabled",
      "temperature=1",
    ],
    "OpenRouter trace should report the 131072-token cap, GLM 5.2 max effort fallback, and default sampling",
  );
});
