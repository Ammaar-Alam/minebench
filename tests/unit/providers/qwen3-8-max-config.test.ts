import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
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

  const model = getModelByKey("qwen_qwen3_8_max");
  assert.equal(model.provider, "qwen");
  assert.equal(model.modelId, "qwen3.8-max");
  assert.equal(model.displayName, "Qwen 3.8 Max");
  assert.equal(model.openRouterModelId, "qwen/qwen3.8-max");
  assert.equal(model.forceOpenRouter, true);
  assert.equal(MODEL_SLUG.qwen_qwen3_8_max, "qwen3-8-max");

  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId, "medium"), [
    "medium",
    "low",
    "minimal",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId, "minimal"), [
    "minimal",
  ]);

  const profile = getModelBenchmarkProfile(model.key);
  assert.deepEqual(profile?.parameters, [
    { label: "Reasoning effort", value: "XHigh" },
  ]);

  const traces: string[] = [];
  await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => traces.push(message),
  });

  const request = capturedRequests.find((candidate) =>
    candidate.url.includes("openrouter.test"),
  )?.body;
  assert.ok(request, "OpenRouter request should be captured");
  assert.equal(request.model, "qwen/qwen3.8-max");
  assert.equal(request.max_tokens, 131072);
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
  assert.ok(
    traces.some((trace) =>
      trace.includes("Routing via OpenRouter (qwen/qwen3.8-max)") &&
      trace.includes("max_output_tokens=131072") &&
      trace.includes("effort_fallback=xhigh->high->medium->low->minimal->disabled") &&
      trace.includes("temperature=default"),
    ),
    "OpenRouter trace should report Qwen 3.8 Max's output cap, effort ladder, and provider-default sampling",
  );

  console.log("Qwen 3.8 Max config checks passed");
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
