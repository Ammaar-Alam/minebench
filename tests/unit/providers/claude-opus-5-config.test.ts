import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  anthropicAdaptiveEffortAttempts,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const queuedResponseTexts: string[] = [];
let rejectAnthropicMaxOnce = false;
const originalFetch = globalThis.fetch;
const originalEnv = {
  anthropicStreamResponses: process.env.ANTHROPIC_STREAM_RESPONSES,
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL,
  opus5Effort: process.env.ANTHROPIC_OPUS_5_EFFORT,
};

function validBuildJson(): string {
  return JSON.stringify({
    version: "1.0",
    boxes: [],
    lines: [],
    blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
  });
}

function validLargeBuildJson(): string {
  return JSON.stringify({
    version: "1.0",
    boxes: [],
    lines: [],
    blocks: Array.from({ length: 240 }, (_, index) => ({
      x: index % 10,
      y: Math.floor(index / 10) % 6,
      z: Math.floor(index / 60),
      type: "stone",
    })),
  });
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  assert.ok(init?.body, "provider request should include a JSON body");
  assert.equal(typeof init.body, "string", "provider request body should be serialized JSON");

  const url = String(input);
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  capturedRequests.push({
    url,
    headers: normalizeHeaders(init.headers),
    body,
  });

  if (url.includes("api.anthropic.com")) {
    const effort = (body.output_config as { effort?: unknown } | undefined)?.effort;
    if (rejectAnthropicMaxOnce && effort === "max") {
      rejectAnthropicMaxOnce = false;
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "output_config.effort max is unsupported",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const responseText = queuedResponseTexts.shift() ?? validBuildJson();
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: responseText }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const responseText = queuedResponseTexts.shift() ?? validBuildJson();
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: responseText,
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
  process.env.ANTHROPIC_STREAM_RESPONSES = "0";
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.ANTHROPIC_OPUS_5_EFFORT = "max";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("anthropic_claude_opus_5");
  assert.equal(model.provider, "anthropic");
  assert.equal(model.modelId, "claude-opus-5");
  assert.equal(model.displayName, "Claude Opus 5");
  assert.equal(model.openRouterModelId, "anthropic/claude-opus-5");
  assert.equal(MODEL_SLUG.anthropic_claude_opus_5, "opus-5");

  const benchmarkProfile = getModelBenchmarkProfile(model.key);
  assert.ok(benchmarkProfile, "Claude Opus 5 should have benchmark details");
  assert.deepEqual(benchmarkProfile.parameters, [
    { label: "Thinking", value: "Adaptive" },
    { label: "Reasoning effort", value: "Max" },
    { label: "Sampling", value: "Provider default" },
  ]);
  assert.deepEqual(benchmarkProfile.outputCap, { kind: "exact", tokens: 128_000 });
  assert.deepEqual(benchmarkProfile.averageInference, { milliseconds: 1_930_169 });
  assert.equal(benchmarkProfile.averageJsonSizeBytes, 95_421_017);
  assert.deepEqual(benchmarkProfile.totalCost, { usd: 89.97, attemptCount: 37 });
  assert.equal(benchmarkProfile.totalAttempts, 37);
  assert.equal(benchmarkProfile.buildCount, 15);

  assert.deepEqual(anthropicAdaptiveEffortAttempts(model.modelId), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
  ]);
  assert.deepEqual(anthropicAdaptiveEffortAttempts(model.modelId, "xhigh"), [
    "xhigh",
    "high",
    "medium",
    "low",
  ]);
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
  ]);

  const directTraces: string[] = [];
  const directAttempts: number[] = [];
  const directRawResponses: Array<{ attempt: number; rawText: string }> = [];
  queuedResponseTexts.push("not valid JSON", validBuildJson());
  const directResult = await generateVoxelBuild({
    modelKey: "anthropic_claude_opus_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 2,
    enableTools: false,
    providerKeys: { anthropic: "test-anthropic-key" },
    allowServerKeys: false,
    onProviderRequest: (attempt) => directAttempts.push(attempt),
    onRawResponse: (attempt, rawText) => {
      directRawResponses.push({ attempt, rawText });
    },
    onProviderTrace: (message) => directTraces.push(message),
  });

  assert.equal(directResult.acceptedOutputTokens, 128_000);
  assert.equal(
    directResult.requestConfiguration,
    "Request config: api_mode=messages, max_output_tokens=128000, reasoning_max_tokens=n/a, thinking_mode=adaptive_effort=max, temperature=default, text_verbosity=default, response_format=json_schema.",
  );
  assert.deepEqual(directRawResponses, [
    { attempt: 1, rawText: "not valid JSON" },
    { attempt: 2, rawText: validBuildJson() },
  ]);
  assert.deepEqual(directAttempts, [1, 2]);
  const directRequest = capturedRequests.find((request) =>
    request.url.includes("api.anthropic.com"),
  );
  assert.ok(directRequest, "direct Anthropic request should be captured");
  assert.equal(directRequest.body.model, "claude-opus-5");
  assert.equal(directRequest.body.max_tokens, 128_000);
  assert.equal(Object.hasOwn(directRequest.headers, "anthropic-beta"), false);
  assert.equal(directRequest.headers["anthropic-version"], "2023-06-01");
  assert.equal(Object.hasOwn(directRequest.body, "temperature"), false);
  assert.equal(Object.hasOwn(directRequest.body, "top_p"), false);
  assert.equal(Object.hasOwn(directRequest.body, "top_k"), false);
  assert.deepEqual(directRequest.body.thinking, { type: "adaptive" });
  const directOutputConfig = directRequest.body.output_config as {
    effort?: unknown;
    format?: { type?: unknown };
  };
  assert.equal(directOutputConfig.effort, "max");
  assert.equal(directOutputConfig.format?.type, "json_schema");
  assert.ok(
    directTraces.some((trace) =>
      trace.includes("max_output_tokens=128000") &&
      trace.includes("adaptive_effort=max->xhigh->high->medium->low") &&
      trace.includes("temperature=default"),
    ),
    "direct trace should report the 128000-token cap, max adaptive effort fallback, and default sampling",
  );

  capturedRequests.length = 0;
  rejectAnthropicMaxOnce = true;
  const fallbackRequests: number[] = [];
  queuedResponseTexts.push(validLargeBuildJson());
  const fallbackResult = await generateVoxelBuild({
    modelKey: "anthropic_claude_opus_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    providerKeys: { anthropic: "test-anthropic-key" },
    allowServerKeys: false,
    onProviderRequest: (attempt) => fallbackRequests.push(attempt),
  });
  assert.equal(fallbackResult.ok, true, JSON.stringify(fallbackResult));
  assert.deepEqual(fallbackRequests, [1, 1]);
  assert.deepEqual(
    capturedRequests.map(
      (request) =>
        (request.body.output_config as { effort?: unknown } | undefined)?.effort,
    ),
    ["max", "xhigh"],
  );
  assert.equal(
    fallbackResult.requestConfiguration,
    "Request config: api_mode=messages, max_output_tokens=128000, reasoning_max_tokens=n/a, thinking_mode=adaptive_effort=xhigh, temperature=default, text_verbosity=default, response_format=json_schema.",
  );

  capturedRequests.length = 0;
  const missingKeyAttempts: number[] = [];
  const missingKeyRetries: number[] = [];
  const missingKeyResult = await generateVoxelBuild({
    modelKey: "anthropic_claude_opus_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 2,
    enableTools: false,
    providerKeys: {},
    allowServerKeys: false,
    onProviderRequest: (attempt) => missingKeyAttempts.push(attempt),
    onRetry: (attempt) => missingKeyRetries.push(attempt),
  });
  assert.equal(missingKeyResult.ok, false);
  assert.match(missingKeyResult.error, /Missing API key/);
  assert.deepEqual(missingKeyAttempts, []);
  assert.deepEqual(missingKeyRetries, []);
  assert.equal(capturedRequests.length, 0);

  const invalidReasoningAttempts: number[] = [];
  const invalidReasoningResult = await generateVoxelBuild({
    modelKey: "anthropic_claude_opus_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 2,
    enableTools: false,
    providerKeys: { anthropic: "test-anthropic-key" },
    allowServerKeys: false,
    reasoning: "ultra",
    onProviderRequest: (attempt) => invalidReasoningAttempts.push(attempt),
  });
  assert.equal(invalidReasoningResult.ok, false);
  assert.match(invalidReasoningResult.error, /does not support reasoning 'ultra'/);
  assert.deepEqual(invalidReasoningAttempts, []);
  assert.equal(capturedRequests.length, 0);

  const openRouterTraces: string[] = [];
  queuedResponseTexts.push(validBuildJson());
  const openRouterResult = await generateVoxelBuild({
    modelKey: "anthropic_claude_opus_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    preferOpenRouter: true,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => openRouterTraces.push(message),
  });

  assert.equal(openRouterResult.acceptedOutputTokens, 128_000);
  assert.ok(
    openRouterResult.requestConfiguration?.includes(
      "thinking_mode=reasoning=max",
    ),
  );
  const openRouterRequest = capturedRequests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(openRouterRequest, "OpenRouter request should be captured");
  assert.equal(openRouterRequest.model, "anthropic/claude-opus-5");
  assert.equal(openRouterRequest.max_tokens, 128_000);
  assert.equal(Object.hasOwn(openRouterRequest, "temperature"), false);
  assert.equal(Object.hasOwn(openRouterRequest, "top_p"), false);
  assert.equal(Object.hasOwn(openRouterRequest, "top_k"), false);
  assert.deepEqual(openRouterRequest.reasoning, { effort: "max" });
  assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
  assert.equal(
    (
      openRouterRequest.response_format as {
        type?: unknown;
        json_schema?: { strict?: unknown };
      }
    ).type,
    "json_schema",
  );
  assert.equal(
    (
      openRouterRequest.response_format as {
        json_schema?: { strict?: unknown };
      }
    ).json_schema?.strict,
    true,
  );
  assert.ok(
    openRouterTraces.some((trace) =>
      trace.includes("max_output_tokens=128000") &&
      trace.includes("effort_fallback=max->xhigh->high->medium->low->disabled") &&
      trace.includes("temperature=default"),
    ),
    "OpenRouter trace should report the 128000-token cap, max reasoning fallback, and default sampling",
  );

  capturedRequests.length = 0;
  process.env.ANTHROPIC_OPUS_5_EFFORT = "low";
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "low",
  ]);
  queuedResponseTexts.push(validBuildJson());
  await generateVoxelBuild({
    modelKey: "anthropic_claude_opus_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    providerKeys: { anthropic: "test-anthropic-key" },
    allowServerKeys: false,
  });

  const lowEffortRequest = capturedRequests.find((request) =>
    request.url.includes("api.anthropic.com"),
  );
  assert.ok(lowEffortRequest, "low-effort direct Anthropic request should be captured");
  assert.equal(
    (lowEffortRequest.body.output_config as { effort?: unknown }).effort,
    "low",
  );

  console.log("claude opus 5 config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ["ANTHROPIC_STREAM_RESPONSES", originalEnv.anthropicStreamResponses],
      ["MINEBENCH_MAX_OUTPUT_TOKENS", originalEnv.maxOutputTokens],
      ["OPENROUTER_BASE_URL", originalEnv.openRouterBaseUrl],
      ["ANTHROPIC_OPUS_5_EFFORT", originalEnv.opus5Effort],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
