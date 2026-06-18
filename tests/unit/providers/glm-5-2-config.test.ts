import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import { openRouterReasoningEffortAttempts } from "../../../lib/ai/reasoningProfiles";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
};

function validBuildJson(): string {
  return JSON.stringify({
    version: "1.0",
    boxes: [],
    lines: [],
    blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  assert.ok(init?.body, "OpenRouter request should include a JSON body");
  assert.equal(typeof init.body, "string", "OpenRouter request body should be serialized JSON");

  capturedRequests.push({
    url: String(input),
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  });

  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: validBuildJson(),
          },
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}) as typeof fetch;

async function main() {
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("zai_glm_5_2");

  assert.equal(model.provider, "zai");
  assert.equal(model.modelId, "glm-5.2");
  assert.equal(model.displayName, "Z.AI GLM 5.2");
  assert.equal(model.openRouterModelId, "z-ai/glm-5.2");
  assert.equal(model.forceOpenRouter, true);
  assert.equal(MODEL_SLUG.zai_glm_5_2, "glm-5-2");
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "xhigh",
    "high",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId, "max"), [
    "xhigh",
    "high",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId, "high"), [
    "high",
  ]);

  const traces: string[] = [];
  await generateVoxelBuild({
    modelKey: "zai_glm_5_2",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => traces.push(message),
  });

  const openRouterRequest = capturedRequests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(openRouterRequest, "OpenRouter request should be captured");
  assert.equal(openRouterRequest.model, "z-ai/glm-5.2");
  assert.equal(openRouterRequest.max_tokens, 131072);
  assert.deepEqual(openRouterRequest.reasoning, { effort: "xhigh" });
  assert.ok(
    traces.some((trace) =>
      trace.includes("max_output_tokens=131072") &&
      trace.includes("effort_fallback=xhigh->high->disabled") &&
      trace.includes("temperature=1"),
    ),
    "OpenRouter trace should report the 131072-token cap, GLM 5.2 max effort fallback, and default sampling",
  );

  console.log("glm 5.2 config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv.maxOutputTokens === undefined) {
      delete process.env.MINEBENCH_MAX_OUTPUT_TOKENS;
    } else {
      process.env.MINEBENCH_MAX_OUTPUT_TOKENS = originalEnv.maxOutputTokens;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
