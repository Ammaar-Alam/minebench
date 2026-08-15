import assert from "node:assert/strict";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import { openRouterReasoningEffortAttempts } from "../../../lib/ai/reasoningProfiles";
import {
  assertCatalogEntry,
  assertTraceLine,
  runGeneration,
  runProviderConfigTest,
} from "../../helpers/providerConfigHarness";

runProviderConfigTest("qwen family", {}, async (capture) => {
  const model = assertCatalogEntry({
    key: "qwen_qwen3_8_max",
    provider: "qwen",
    modelId: "qwen3.8-max",
    displayName: "Qwen 3.8 Max",
    openRouterModelId: "qwen/qwen3.8-max",
    slug: "qwen3-8-max",
    forceOpenRouter: true,
  });

  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!), [
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!, "medium"), [
    "medium",
    "low",
    "minimal",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!, "minimal"), [
    "minimal",
  ]);

  const profile = getModelBenchmarkProfile(model.key);
  assert.deepEqual(profile?.parameters, [{ label: "Reasoning effort", value: "XHigh" }]);

  const openRouter = await runGeneration(capture, {
    modelKey: model.key,
    providerKeys: { openrouter: "test-openrouter-key" },
  });
  const request = openRouter.requests.find((candidate) =>
    candidate.url.includes("openrouter.test"),
  )?.body;
  assert.ok(request, "OpenRouter request should be captured");
  assert.equal(request.model, "qwen/qwen3.8-max");
  assert.equal(request.max_tokens, 131_072);
  assert.deepEqual(request.reasoning, { effort: "xhigh" });
  assert.equal(Object.hasOwn(request, "temperature"), false);
  assert.deepEqual(request.provider, { require_parameters: true });
  const responseFormat = request.response_format as {
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
      "Routing via OpenRouter (qwen/qwen3.8-max)",
      "max_output_tokens=131072",
      "effort_fallback=xhigh->high->medium->low->minimal->disabled",
      "temperature=default",
    ],
    "OpenRouter trace should report Qwen 3.8 Max's output cap, effort ladder, and provider-default sampling",
  );
});
