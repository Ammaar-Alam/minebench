import assert from "node:assert/strict";
import { openRouterReasoningEffortAttempts } from "../../../lib/ai/reasoningProfiles";
import {
  assertCatalogEntry,
  assertTraceLine,
  runGeneration,
  runProviderConfigTest,
} from "../../helpers/providerConfigHarness";

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
