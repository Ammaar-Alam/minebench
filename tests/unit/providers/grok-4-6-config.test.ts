import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  modelRequiresReasoning,
  openRouterReasoningEffortAttempts,
  xaiReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { xaiRequestConfigForModel } from "../../../lib/ai/providers/xai";
import { voxelExecToolCallJsonSchema } from "../../../lib/ai/tools/voxelExec";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalLookup = dns.lookup;
const originalHttpsRequest = https.request;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL,
  xaiBaseUrl: process.env.XAI_BASE_URL,
};

let rejectXaiStructuredOutput = false;

function validToolCallJson(): string {
  return JSON.stringify({
    tool: "voxel.exec",
    input: {
      code: 'box(0, 0, 0, 4, 4, 4, "stone");',
      gridSize: 64,
      palette: "simple",
      seed: 123,
    },
  });
}

function assertStructuredOutput(body: Record<string, unknown>): void {
  const responseFormat = body.response_format as {
    type?: unknown;
    json_schema?: { name?: unknown; strict?: unknown; schema?: unknown };
  };
  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema?.name, "voxel_build_response");
  assert.equal(responseFormat.json_schema?.strict, true);
  assert.deepEqual(responseFormat.json_schema?.schema, voxelExecToolCallJsonSchema());
}

const xaiServer = http.createServer(async (request, response) => {
  let rawBody = "";
  for await (const chunk of request) rawBody += chunk.toString();

  capturedRequests.push({
    url: `https://${request.headers.host}${request.url}`,
    body: JSON.parse(rawBody) as Record<string, unknown>,
  });
  response.setHeader("Content-Type", "application/json");
  if (rejectXaiStructuredOutput) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
    return;
  }
  response.end(JSON.stringify({ choices: [{ message: { content: validToolCallJson() } }] }));
});

Object.defineProperty(dns, "lookup", {
  configurable: true,
  value: async () => [{ address: "93.184.216.34", family: 4 }],
});

Object.defineProperty(https, "request", {
  configurable: true,
  value: ((
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => http.request({ ...options, hostname: "127.0.0.1", family: 4 }, callback)) as typeof https.request,
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  assert.ok(init?.body, "OpenRouter request should include a JSON body");
  assert.equal(typeof init.body, "string");
  capturedRequests.push({
    url: String(input),
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  });

  return new Response(
    JSON.stringify({ choices: [{ message: { content: validToolCallJson() } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

async function main() {
  await new Promise<void>((resolve) => xaiServer.listen(0, "127.0.0.1", resolve));
  const address = xaiServer.address();
  assert.ok(address && typeof address !== "string");

  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.XAI_BASE_URL = `https://xai.test:${address.port}/v1`;
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("xai_grok_4_6");
  assert.equal(model.provider, "xai");
  assert.equal(model.modelId, "grok-4.6");
  assert.equal(model.displayName, "Grok 4.6");
  assert.equal(model.openRouterModelId, "x-ai/grok-4.6");
  assert.equal(model.forceOpenRouter, undefined);
  assert.equal(MODEL_SLUG.xai_grok_4_6, "grok-4-6");
  assert.equal(modelRequiresReasoning(model.modelId), true);
  assert.equal(modelRequiresReasoning(model.openRouterModelId), true);

  const effortLadder = ["xhigh", "high", "medium", "low"];
  assert.deepEqual(xaiReasoningEffortAttempts(model.modelId), effortLadder);
  assert.deepEqual(xaiReasoningEffortAttempts(model.modelId, "max"), effortLadder);
  assert.deepEqual(xaiReasoningEffortAttempts(model.modelId, "medium"), [
    "medium",
    "low",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), effortLadder);
  assert.throws(
    () => xaiReasoningEffortAttempts(model.modelId, "none"),
    /Supported values: xhigh, high, medium, low\./,
  );
  assert.deepEqual(xaiRequestConfigForModel(model.modelId), {
    maxTokensParameter: "max_completion_tokens",
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(getModelBenchmarkProfile(model.key)?.parameters, [
    { label: "Reasoning effort", value: "XHigh" },
    { label: "Sampling", value: "Provider default" },
  ]);

  const directTraces: string[] = [];
  const directResult = await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: true,
    providerKeys: { xai: "test-xai-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => directTraces.push(message),
  });
  assert.equal(directResult.providerRoute, "direct");
  assert.equal(directResult.acceptedOutputTokens, 496_000);

  const directRequest = capturedRequests.find((candidate) =>
    candidate.url.includes("xai.test"),
  );
  assert.ok(directRequest, "Direct xAI request should be captured");
  assert.equal(directRequest.body.model, "grok-4.6");
  assert.equal(directRequest.body.max_completion_tokens, 496000);
  assert.equal("max_tokens" in directRequest.body, false);
  assert.equal(directRequest.body.reasoning_effort, "xhigh");
  assert.equal("temperature" in directRequest.body, false);
  assertStructuredOutput(directRequest.body);
  assert.ok(
    directTraces.some((trace) =>
      trace.includes("Routing via direct xai provider (grok-4.6)") &&
      trace.includes("max_output_tokens=496000") &&
      trace.includes("thinking_mode=reasoning_effort=xhigh") &&
      trace.includes("temperature=default"),
    ),
  );

  const openRouterStart = capturedRequests.length;
  const openRouterTraces: string[] = [];
  const openRouterResult = await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: true,
    preferOpenRouter: true,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => openRouterTraces.push(message),
  });
  assert.equal(openRouterResult.providerRoute, "openrouter");

  const openRouterRequest = capturedRequests
    .slice(openRouterStart)
    .find((candidate) => candidate.url.includes("openrouter.test"));
  assert.ok(openRouterRequest, "OpenRouter request should be captured");
  assert.equal(openRouterRequest.body.model, "x-ai/grok-4.6");
  assert.equal(openRouterRequest.body.max_tokens, 496000);
  assert.deepEqual(openRouterRequest.body.reasoning, { effort: "xhigh" });
  assert.equal("temperature" in openRouterRequest.body, false);
  assert.deepEqual(openRouterRequest.body.provider, { require_parameters: true });
  assertStructuredOutput(openRouterRequest.body);
  assert.ok(
    openRouterTraces.some((trace) =>
      trace.includes("Routing via OpenRouter (x-ai/grok-4.6)") &&
      trace.includes("effort_fallback=xhigh->high->medium->low") &&
      !trace.includes("disabled") &&
      trace.includes("temperature=default"),
    ),
  );

  rejectXaiStructuredOutput = true;
  const strictFailureStart = capturedRequests.length;
  const strictFailure = await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: true,
    providerKeys: { xai: "test-xai-key" },
    allowServerKeys: false,
  });
  assert.equal(strictFailure.ok, false);
  assert.match(strictFailure.error, /xAI error 400.*response_format unsupported/);
  const strictFailureRequests = capturedRequests.slice(strictFailureStart);
  assert.equal(strictFailureRequests.length, 1, "Grok 4.6 must not retry without response_format");
  assertStructuredOutput(strictFailureRequests[0].body);
  rejectXaiStructuredOutput = false;

  console.log("Grok 4.6 config checks passed");
}

main()
  .finally(async () => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(dns, "lookup", { configurable: true, value: originalLookup });
    Object.defineProperty(https, "request", {
      configurable: true,
      value: originalHttpsRequest,
    });
    await new Promise<void>((resolve) => xaiServer.close(() => resolve()));

    for (const [name, value] of Object.entries({
      MINEBENCH_MAX_OUTPUT_TOKENS: originalEnv.maxOutputTokens,
      OPENROUTER_BASE_URL: originalEnv.openRouterBaseUrl,
      XAI_BASE_URL: originalEnv.xaiBaseUrl,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
