import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  geminiThinkingConfigForModel,
  modelRequiresReasoning,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { MODEL_KEY_BY_SLUG, MODEL_SLUG } from "../../../scripts/uploadsCatalog";

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
  assert.equal(typeof init?.body, "string");
  const url = String(input);
  capturedRequests.push({
    url,
    body: JSON.parse(init?.body as string) as Record<string, unknown>,
  });

  const response = url.includes("generativelanguage.googleapis.com")
    ? { candidates: [{ content: { parts: [{ text: validBuildJson() }] } }] }
    : { choices: [{ message: { content: validBuildJson() } }] };
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

async function main() {
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("gemini_3_7_flash");
  assert.equal(model.provider, "gemini");
  assert.equal(model.modelId, "gemini-3.7-flash");
  assert.equal(model.displayName, "Gemini 3.7 Flash");
  assert.equal(model.enabled, true);
  assert.equal(model.openRouterModelId, "google/gemini-3.7-flash");
  assert.equal(MODEL_SLUG[model.key], "gemini-3-7-flash");
  assert.equal(MODEL_KEY_BY_SLUG["gemini-3-7-flash"], model.key);

  assert.deepEqual(geminiThinkingConfigForModel(model.modelId), {
    thinkingLevel: "high",
  });
  assert.throws(
    () => geminiThinkingConfigForModel(model.modelId, "minimal"),
    /Supported values: high, medium, low/,
  );
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "high",
    "medium",
    "low",
  ]);
  assert.equal(modelRequiresReasoning(model.openRouterModelId), true);

  const directTraces: string[] = [];
  await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    providerKeys: { gemini: "test-google-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => directTraces.push(message),
  });

  const directRequest = capturedRequests.find((candidate) =>
    candidate.url.includes("/models/gemini-3.7-flash:generateContent"),
  )?.body;
  assert.ok(directRequest, "Direct Gemini 3.7 Flash request should be captured");
  const generationConfig = directRequest.generationConfig as Record<string, unknown>;
  assert.equal(generationConfig.maxOutputTokens, 65_536);
  assert.deepEqual(generationConfig.thinkingConfig, { thinkingLevel: "high" });
  assert.equal("thinkingBudget" in generationConfig, false);
  assert.equal("temperature" in generationConfig, false);
  assert.equal(generationConfig.responseMimeType, "application/json");
  assert.ok(generationConfig.responseJsonSchema);
  assert.ok(
    directTraces.some((trace) =>
      trace.includes("Routing via direct gemini provider (gemini-3.7-flash)") &&
      trace.includes("max_output_tokens=65536") &&
      trace.includes("thinking_mode=thinking_level=high") &&
      trace.includes("temperature=default"),
    ),
  );

  const openRouterStart = capturedRequests.length;
  const openRouterTraces: string[] = [];
  await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => openRouterTraces.push(message),
  });

  const openRouterRequest = capturedRequests
    .slice(openRouterStart)
    .find((candidate) => candidate.body.model === "google/gemini-3.7-flash")?.body;
  assert.ok(openRouterRequest, "OpenRouter Gemini 3.7 Flash request should be captured");
  assert.equal(openRouterRequest.max_tokens, 65_536);
  assert.deepEqual(openRouterRequest.reasoning, { effort: "high" });
  assert.equal("temperature" in openRouterRequest, false);
  assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
  const responseFormat = openRouterRequest.response_format as {
    type?: unknown;
    json_schema?: { strict?: unknown; schema?: unknown };
  };
  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema?.strict, true);
  assert.ok(responseFormat.json_schema?.schema);
  assert.ok(
    openRouterTraces.some((trace) =>
      trace.includes("Routing via OpenRouter (google/gemini-3.7-flash)") &&
      trace.includes("effort_fallback=high->medium->low") &&
      !trace.includes("disabled") &&
      trace.includes("temperature=default"),
    ),
  );

  console.log("Gemini 3.7 Flash config checks passed");
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
