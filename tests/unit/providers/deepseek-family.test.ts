import assert from "node:assert/strict";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import {
  deepseekThinkingConfigForModel,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import {
  assertCatalogEntry,
  assertTraceLine,
  runGeneration,
  runProviderConfigTest,
} from "../../helpers/providerConfigHarness";

runProviderConfigTest(
  "deepseek family",
  { DEEPSEEK_BASE_URL: "https://deepseek.test" },
  async (capture) => {
    const model = assertCatalogEntry({
      key: "deepseek_v4_flash_0731",
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash 0731",
      openRouterModelId: "deepseek/deepseek-v4-flash-0731",
      slug: "deepseek-v4-flash-0731",
    });

    assert.deepEqual(deepseekThinkingConfigForModel(model.modelId), {
      type: "enabled",
      reasoningEffort: "max",
    });
    assert.deepEqual(deepseekThinkingConfigForModel(model.modelId, "low"), {
      type: "enabled",
      reasoningEffort: "low",
    });
    assert.deepEqual(deepseekThinkingConfigForModel(model.modelId, "xhigh"), {
      type: "enabled",
      reasoningEffort: "high",
    });
    assert.throws(
      () => deepseekThinkingConfigForModel("deepseek-v4-pro", "low"),
      /Supported values: max, high, disabled\./,
    );
    assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!), [
      "max",
      "high",
      "low",
    ]);
    assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!, "max"), [
      "max",
      "high",
      "low",
    ]);
    assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!, "xhigh"), [
      "max",
      "high",
      "low",
    ]);
    assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!, "high"), [
      "high",
      "low",
    ]);

    const profile = getModelBenchmarkProfile(model.key);
    assert.deepEqual(profile?.parameters, [
      { label: "Thinking", value: "Enabled" },
      { label: "Reasoning effort", value: "Max" },
    ]);
    assert.equal(profile?.sourceRelease, "3.12.0");
    assert.deepEqual(profile?.outputCap, { kind: "exact", tokens: 384_000 });
    assert.deepEqual(profile?.averageInference, { milliseconds: 526_265 });
    assert.equal(profile?.averageJsonSizeBytes, 18_416_164);
    assert.equal(profile?.totalAttempts, 24);
    assert.equal(profile?.buildCount, 15);
    assert.deepEqual(profile?.totalCost, { usd: 0.28, attemptCount: 24 });

    const direct = await runGeneration(capture, {
      modelKey: model.key,
      providerKeys: { deepseek: "test-deepseek-key" },
    });
    const directRequest = direct.requests.find((request) =>
      request.url.includes("deepseek.test"),
    )?.body;
    assert.ok(directRequest, "Direct DeepSeek request should be captured");
    assert.equal(directRequest.model, "deepseek-v4-flash");
    assert.equal(directRequest.max_tokens, 384_000);
    assert.deepEqual(directRequest.thinking, { type: "enabled" });
    assert.equal(directRequest.reasoning_effort, "max");
    assert.equal("temperature" in directRequest, false);
    assert.deepEqual(directRequest.response_format, { type: "json_object" });
    assertTraceLine(
      direct.traces,
      [
        "Routing via direct deepseek provider (deepseek-v4-flash)",
        "max_output_tokens=384000",
        "thinking_mode=thinking=max",
        "temperature=n/a",
      ],
      "Direct DeepSeek trace should report the maximum output and reasoning settings",
    );

    const openRouter = await runGeneration(capture, {
      modelKey: model.key,
      providerKeys: { openrouter: "test-openrouter-key" },
    });
    const openRouterRequest = openRouter.requests.find((request) =>
      request.url.includes("openrouter.test"),
    )?.body;
    assert.ok(openRouterRequest, "OpenRouter request should be captured");
    assert.equal(openRouterRequest.model, "deepseek/deepseek-v4-flash-0731");
    assert.equal(openRouterRequest.max_tokens, 384_000);
    assert.deepEqual(openRouterRequest.reasoning, { effort: "max" });
    assert.equal(openRouterRequest.temperature, 1);
    assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
    const responseFormat = openRouterRequest.response_format as {
      type?: unknown;
      json_schema?: { name?: unknown; strict?: unknown; schema?: unknown };
    };
    assert.equal(responseFormat.type, "json_schema");
    assert.equal(responseFormat.json_schema?.name, "voxel_build_response");
    assert.equal(responseFormat.json_schema?.strict, true);
    assert.ok(responseFormat.json_schema?.schema);
    assertTraceLine(
      openRouter.traces,
      [
        "Routing via OpenRouter (deepseek/deepseek-v4-flash-0731)",
        "max_output_tokens=384000",
        "effort_fallback=max->high->low->disabled",
        "temperature=1",
      ],
      "OpenRouter trace should report maximum reasoning and output settings",
    );
  },
);
