import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  deepseekThinkingConfigForModel,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL,
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
  assert.ok(init?.body, "Provider request should include a JSON body");
  assert.equal(typeof init.body, "string", "Provider request body should be serialized JSON");
  capturedRequests.push({
    url: String(input),
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  });

  return new Response(
    JSON.stringify({ choices: [{ message: { content: validBuildJson() } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

async function main() {
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.DEEPSEEK_BASE_URL = "https://deepseek.test";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("deepseek_v4_flash_0731");
  assert.equal(model.provider, "deepseek");
  assert.equal(model.modelId, "deepseek-v4-flash");
  assert.equal(model.displayName, "DeepSeek V4 Flash 0731");
  assert.equal(model.openRouterModelId, "deepseek/deepseek-v4-flash-0731");
  assert.equal(MODEL_SLUG.deepseek_v4_flash_0731, "deepseek-v4-flash-0731");

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
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "max",
    "high",
    "low",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId, "max"), [
    "max",
    "high",
    "low",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId, "xhigh"), [
    "max",
    "high",
    "low",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId, "high"), [
    "high",
    "low",
  ]);

  const profile = getModelBenchmarkProfile(model.key);
  assert.deepEqual(profile?.parameters, [
    { label: "Thinking", value: "Enabled" },
    { label: "Reasoning effort", value: "Max" },
  ]);
  assert.equal(profile?.sourceRelease, "3.12.0");
  assert.deepEqual(profile?.outputCap, { kind: "exact", tokens: 384000 });
  assert.deepEqual(profile?.averageInference, { milliseconds: 526265 });
  assert.equal(profile?.averageJsonSizeBytes, 18416164);
  assert.equal(profile?.totalAttempts, 24);
  assert.equal(profile?.buildCount, 15);
  assert.deepEqual(profile?.totalCost, { usd: 0.28, attemptCount: 24 });

  const directTraces: string[] = [];
  await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { deepseek: "test-deepseek-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => directTraces.push(message),
  });

  const directRequest = capturedRequests.find((request) =>
    request.url.includes("deepseek.test"),
  )?.body;
  assert.ok(directRequest, "Direct DeepSeek request should be captured");
  assert.equal(directRequest.model, "deepseek-v4-flash");
  assert.equal(directRequest.max_tokens, 384000);
  assert.deepEqual(directRequest.thinking, { type: "enabled" });
  assert.equal(directRequest.reasoning_effort, "max");
  assert.equal("temperature" in directRequest, false);
  assert.deepEqual(directRequest.response_format, { type: "json_object" });
  assert.ok(
    directTraces.some((trace) =>
      trace.includes("Routing via direct deepseek provider (deepseek-v4-flash)") &&
      trace.includes("max_output_tokens=384000") &&
      trace.includes("thinking_mode=thinking=max") &&
      trace.includes("temperature=n/a"),
    ),
    "Direct DeepSeek trace should report the maximum output and reasoning settings",
  );

  const openRouterTraces: string[] = [];
  await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => openRouterTraces.push(message),
  });

  const openRouterRequest = capturedRequests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(openRouterRequest, "OpenRouter request should be captured");
  assert.equal(openRouterRequest.model, "deepseek/deepseek-v4-flash-0731");
  assert.equal(openRouterRequest.max_tokens, 384000);
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
  assert.ok(
    openRouterTraces.some((trace) =>
      trace.includes("Routing via OpenRouter (deepseek/deepseek-v4-flash-0731)") &&
      trace.includes("max_output_tokens=384000") &&
      trace.includes("effort_fallback=max->high->low->disabled") &&
      trace.includes("temperature=1"),
    ),
    "OpenRouter trace should report maximum reasoning and output settings",
  );

  console.log("deepseek v4 flash config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      MINEBENCH_MAX_OUTPUT_TOKENS: originalEnv.maxOutputTokens,
      DEEPSEEK_BASE_URL: originalEnv.deepseekBaseUrl,
      OPENROUTER_BASE_URL: originalEnv.openRouterBaseUrl,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
