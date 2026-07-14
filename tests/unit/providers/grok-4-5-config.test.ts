import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  openRouterReasoningEffortAttempts,
  xaiAutomaticReasoningForModel,
  xaiReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { xaiRequestConfigForModel } from "../../../lib/ai/providers/xai";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL,
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

  const model = getModelByKey("xai_grok_4_5");

  assert.equal(model.provider, "xai");
  assert.equal(model.modelId, "grok-4.5");
  assert.equal(model.displayName, "Grok 4.5");
  assert.equal(model.openRouterModelId, "x-ai/grok-4.5");
  assert.equal(model.forceOpenRouter, undefined);
  assert.equal(MODEL_SLUG.xai_grok_4_5, "grok-4-5");
  assert.deepEqual(xaiReasoningEffortAttempts(model.modelId), ["high", "medium", "low"]);
  assert.deepEqual(xaiReasoningEffortAttempts(model.modelId, "max"), [
    "high",
    "medium",
    "low",
  ]);
  assert.deepEqual(xaiReasoningEffortAttempts(model.modelId, "medium"), [
    "medium",
    "low",
  ]);
  assert.equal(
    xaiReasoningEffortAttempts("grok-4.3", "automatic"),
    undefined,
    "automatic xAI models should bypass the explicit effort helper",
  );
  assert.equal(
    xaiAutomaticReasoningForModel("grok-4.3", "automatic"),
    "automatic",
    "Grok 4.3 should preserve its automatic reasoning override",
  );
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "high",
    "medium",
    "low",
  ]);
  assert.deepEqual(xaiRequestConfigForModel(model.modelId), {
    maxTokensParameter: "max_completion_tokens",
    reasoningEffort: "high",
  });

  const traces: string[] = [];
  await generateVoxelBuild({
    modelKey: "xai_grok_4_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    preferOpenRouter: true,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => traces.push(message),
  });

  const request = capturedRequests.find((candidate) =>
    candidate.url.includes("openrouter.test"),
  )?.body;
  assert.ok(request, "OpenRouter request should be captured");
  assert.equal(request.model, "x-ai/grok-4.5");
  assert.equal(request.max_tokens, 500000);
  assert.deepEqual(request.reasoning, { effort: "high" });
  assert.equal(
    ((request.response_format as { json_schema?: { strict?: unknown } })?.json_schema)?.strict,
    true,
  );
  assert.ok(
    traces.some((trace) =>
      trace.includes("max_output_tokens=500000") &&
      trace.includes("effort_fallback=high->medium->low->disabled") &&
      trace.includes("temperature=1"),
    ),
    "OpenRouter trace should report the context-bounded cap and highest reasoning effort",
  );

  console.log("grok 4.5 config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv.maxOutputTokens === undefined) {
      delete process.env.MINEBENCH_MAX_OUTPUT_TOKENS;
    } else {
      process.env.MINEBENCH_MAX_OUTPUT_TOKENS = originalEnv.maxOutputTokens;
    }
    if (originalEnv.openRouterBaseUrl === undefined) {
      delete process.env.OPENROUTER_BASE_URL;
    } else {
      process.env.OPENROUTER_BASE_URL = originalEnv.openRouterBaseUrl;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
