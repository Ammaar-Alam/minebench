import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  openAiReasoningEffortAttempts,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  useBackgroundMode: process.env.OPENAI_USE_BACKGROUND_MODE,
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
  assert.ok(init?.body, "Provider request should include a JSON body");
  assert.equal(typeof init.body, "string", "Provider request body should be serialized JSON");

  const url = String(input);
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  capturedRequests.push({ url, body });

  if (url.includes("/chat/completions")) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: validBuildJson() } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ output_text: validBuildJson(), status: "completed" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

async function main() {
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.OPENAI_USE_BACKGROUND_MODE = "0";

  const model = getModelByKey("openai_gpt_5_6_luna");

  assert.equal(model.provider, "openai");
  assert.equal(model.modelId, "gpt-5.6-luna");
  assert.equal(model.displayName, "GPT 5.6 Luna Pro");
  assert.equal(model.openRouterModelId, "openai/gpt-5.6-luna-pro");
  assert.equal(MODEL_SLUG.openai_gpt_5_6_luna, "gpt-5-6-luna");
  assert.deepEqual(openAiReasoningEffortAttempts(model.modelId), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "none",
  ]);
  assert.deepEqual(openAiReasoningEffortAttempts(model.modelId, "max"), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "none",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "none",
  ]);

  const directTraces: string[] = [];
  const directResult = await generateVoxelBuild({
    modelKey: "openai_gpt_5_6_luna",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    maxAttempts: 1,
    providerKeys: { openai: "test-openai-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => directTraces.push(message),
  });
  assert.equal(directResult.acceptedOutputTokens, 128_000);
  assert.equal(directResult.providerRoute, "direct");
  assert.ok(directResult.requestConfiguration?.includes("api_mode=responses_sync"));

  const directRequest = capturedRequests.find((candidate) =>
    candidate.url.includes("api.openai.com/v1/responses"),
  )?.body;
  assert.ok(directRequest, "OpenAI Responses request should be captured");
  assert.equal(directRequest.model, "gpt-5.6-luna");
  assert.equal(directRequest.max_output_tokens, 128000);
  assert.equal(Object.hasOwn(directRequest, "temperature"), false);
  assert.deepEqual(directRequest.reasoning, { effort: "max", mode: "pro" });
  assert.deepEqual((directRequest.text as { verbosity?: unknown })?.verbosity, "high");
  assert.equal(
    ((directRequest.text as { format?: { type?: unknown } })?.format)?.type,
    "json_schema",
  );
  assert.ok(
    directTraces.some(
      (trace) =>
        trace.includes("Routing via direct openai provider (gpt-5.6-luna)") &&
        trace.includes("max_output_tokens=128000") &&
        trace.includes("reasoning_mode=pro") &&
        trace.includes("temperature=default"),
    ),
    "direct trace should report Luna's cap, pro mode, max reasoning, and default sampling",
  );

  const openRouterTraces: string[] = [];
  const openRouterResult = await generateVoxelBuild({
    modelKey: "openai_gpt_5_6_luna",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    maxAttempts: 1,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => openRouterTraces.push(message),
  });
  assert.equal(openRouterResult.acceptedOutputTokens, 128_000);
  assert.equal(openRouterResult.providerRoute, "openrouter");

  const openRouterRequest = capturedRequests.find((candidate) =>
    candidate.url.includes("/chat/completions"),
  )?.body;
  assert.ok(openRouterRequest, "OpenRouter request should be captured");
  assert.equal(openRouterRequest.model, "openai/gpt-5.6-luna-pro");
  assert.equal(openRouterRequest.max_tokens, 128000);
  assert.deepEqual(openRouterRequest.reasoning, { effort: "max" });
  assert.equal(Object.hasOwn(openRouterRequest, "temperature"), false);
  assert.equal(Object.hasOwn(openRouterRequest, "text"), false);
  assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
  assert.equal(
    (openRouterRequest.response_format as { type?: unknown })?.type,
    "json_schema",
  );
  const openRouterJsonSchema = (
    openRouterRequest.response_format as {
      json_schema?: { strict?: unknown; schema?: unknown };
    }
  )?.json_schema;
  assert.equal(openRouterJsonSchema?.strict, true);
  assert.ok(openRouterJsonSchema?.schema, "OpenRouter request should include the voxel schema");
  assert.ok(
    openRouterTraces.some(
      (trace) =>
        trace.includes("Routing via OpenRouter (openai/gpt-5.6-luna-pro)") &&
        trace.includes("max_output_tokens=128000") &&
        trace.includes("effort_fallback=max->xhigh->high->medium->low->none->disabled") &&
        trace.includes("temperature=default"),
    ),
    "OpenRouter trace should report Luna Pro, its cap, and the max reasoning fallback",
  );

  console.log("gpt 5.6 luna config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv.maxOutputTokens === undefined) {
      delete process.env.MINEBENCH_MAX_OUTPUT_TOKENS;
    } else {
      process.env.MINEBENCH_MAX_OUTPUT_TOKENS = originalEnv.maxOutputTokens;
    }
    if (originalEnv.useBackgroundMode === undefined) {
      delete process.env.OPENAI_USE_BACKGROUND_MODE;
    } else {
      process.env.OPENAI_USE_BACKGROUND_MODE = originalEnv.useBackgroundMode;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
