import assert from "node:assert/strict";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import { zaiGenerateText } from "../../../lib/ai/providers/zai";
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
  validBuildJson,
} from "../../helpers/providerConfigHarness";

runProviderConfigTest("zai family", {
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
  assert.deepEqual(getModelBenchmarkProfile(model.key)?.totalCost, { usd: 6.42, attemptCount: 24 });

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

  const fallbackTraces: string[] = [];
  const fallbackStart = capture.requests.length;
  capture.respondWith((request) => {
    if (!request.url.includes("zai.test")) return null;
    if (request.body.reasoning_effort === "max") {
      return new Response(
        JSON.stringify({ error: "Invalid reasoning_effort enum value: max" }),
        { status: 400 },
      );
    }
    return null;
  });
  await zaiGenerateText({
    modelId: model.modelId,
    apiKey: "test-zai-key",
    system: "system",
    user: "user",
    reasoningEffortAttempts: ["max", "high", "low"],
    onTrace: (message) => fallbackTraces.push(message),
  });
  assert.deepEqual(
    capture.requests
      .slice(fallbackStart)
      .filter((request) => request.url.includes("zai.test"))
      .map((request) => request.body.reasoning_effort),
    ["max", "high"],
  );
  assertTraceLine(
    fallbackTraces,
    ["Z.AI reasoning config 'max' rejected", "falling back to 'high'"],
    "Direct Z.AI should descend its reasoning-effort ladder on configuration rejections",
  );
  assertTraceLine(
    fallbackTraces,
    ["reasoning_effort=high"],
    "Direct Z.AI should report the accepted fallback effort",
  );

  const caller = new AbortController();
  let providerSignal: AbortSignal | null | undefined;
  capture.respondWith((request) => {
    if (!request.url.includes("zai.test")) return null;
    providerSignal = request.signal;
    return new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n',
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  });
  await zaiGenerateText({
    modelId: model.modelId,
    apiKey: "test-zai-key",
    system: "system",
    user: "user",
    reasoningEffortAttempts: ["max", "high", "low"],
    signal: caller.signal,
    onDelta: () => caller.abort(),
  });
  assert.equal(providerSignal?.aborted, true, "Caller cancellation should reach the provider stream");
  capture.respondWith(null);

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

  const flash = assertCatalogEntry({
    key: "zai_glm_5_3_flash",
    provider: "zai",
    modelId: "glm-5.3-flash",
    displayName: "Z.AI GLM 5.3 Flash",
    openRouterModelId: "z-ai/glm-5.3-flash",
    slug: "glm-5-3-flash",
  });
  assert.equal(modelRequiresReasoning(flash.modelId), true);
  assert.equal(modelRequiresReasoning(flash.openRouterModelId!), true);
  assert.deepEqual(zaiReasoningEffortAttempts(flash.modelId), ["max", "high", "low"]);
  assert.deepEqual(openRouterReasoningEffortAttempts(flash.openRouterModelId!), [
    "max",
    "high",
    "low",
  ]);
  assert.deepEqual(getModelBenchmarkProfile(flash.key)?.parameters, [
    { label: "Reasoning effort", value: "Max" },
    { label: "Sampling", value: "Temperature 1 · Top P 0.95" },
  ]);
  assert.deepEqual(getModelBenchmarkProfile(flash.key)?.totalCost, { usd: 0.74 });

  capture.respondWith((request) => {
    if (request.body.model !== flash.modelId || request.body.stream !== true) return null;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: validBuildJson() } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const flashDirect = await runGeneration(capture, {
    modelKey: flash.key,
    providerKeys: {},
    allowServerKeys: true,
  });
  capture.respondWith(null);
  const flashDirectRequest = flashDirect.requests.find((request) =>
    request.url.includes("zai.test"),
  );
  assert.ok(flashDirectRequest, "Direct GLM 5.3 Flash request should be captured");
  assert.equal(flashDirectRequest.body.model, "glm-5.3-flash");
  assert.equal(flashDirectRequest.body.max_tokens, 131_072);
  assert.equal(flashDirectRequest.body.temperature, 1);
  assert.equal(flashDirectRequest.body.top_p, 0.95);
  assert.equal(flashDirectRequest.body.stream, true);
  assert.equal(flashDirectRequest.headers.accept, "text/event-stream");
  assert.equal(flashDirectRequest.body.reasoning_effort, "max");
  assert.deepEqual(flashDirectRequest.body.thinking, {
    type: "enabled",
    clear_thinking: false,
  });
  assert.deepEqual(flashDirectRequest.body.response_format, { type: "json_object" });

  const flashOpenRouter = await runGeneration(capture, {
    modelKey: flash.key,
    providerKeys: { openrouter: "test-openrouter-key" },
    preferOpenRouter: true,
  });
  const flashOpenRouterRequest = flashOpenRouter.requests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(flashOpenRouterRequest, "OpenRouter GLM 5.3 Flash request should be captured");
  assert.equal(flashOpenRouterRequest.model, "z-ai/glm-5.3-flash");
  assert.equal(flashOpenRouterRequest.max_tokens, 131_072);
  assert.equal(flashOpenRouterRequest.temperature, 1);
  assert.equal(flashOpenRouterRequest.top_p, 0.95);
  assert.deepEqual(flashOpenRouterRequest.reasoning, { effort: "max" });
  assert.deepEqual(flashOpenRouterRequest.response_format, { type: "json_object" });

  const glm52 = assertCatalogEntry({
    key: "zai_glm_5_2",
    provider: "zai",
    modelId: "glm-5.2",
    displayName: "Z.AI GLM 5.2",
    openRouterModelId: "z-ai/glm-5.2",
    slug: "glm-5-2",
    forceOpenRouter: true,
  });
  assert.deepEqual(openRouterReasoningEffortAttempts(glm52.openRouterModelId!), [
    "xhigh",
    "high",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(glm52.openRouterModelId!, "max"), [
    "xhigh",
    "high",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(glm52.openRouterModelId!, "high"), [
    "high",
  ]);

  const glm52OpenRouter = await runGeneration(capture, {
    modelKey: glm52.key,
    providerKeys: { openrouter: "test-openrouter-key" },
  });
  const glm52Request = glm52OpenRouter.requests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(glm52Request, "OpenRouter request should be captured");
  assert.equal(glm52Request.model, "z-ai/glm-5.2");
  assert.equal(glm52Request.max_tokens, 131_072);
  assert.deepEqual(glm52Request.reasoning, { effort: "xhigh" });
  assertTraceLine(
    glm52OpenRouter.traces,
    [
      "max_output_tokens=131072",
      "effort_fallback=xhigh->high->disabled",
      "temperature=1",
    ],
    "OpenRouter trace should report the 131072-token cap, GLM 5.2 max effort fallback, and default sampling",
  );
});
