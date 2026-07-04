import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
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
const originalFetch = globalThis.fetch;
const originalEnv = {
  anthropicStreamResponses: process.env.ANTHROPIC_STREAM_RESPONSES,
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  sonnet5Effort: process.env.ANTHROPIC_SONNET_5_EFFORT,
};

function validBuildJson(): string {
  return JSON.stringify({
    version: "1.0",
    boxes: [],
    lines: [],
    blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
  });
}

function validToolCallJson(): string {
  return JSON.stringify({
    tool: "voxel.exec",
    input: {
      code: 'box(0, 0, 0, 11, 7, 11, "stone");',
      gridSize: 64,
      palette: "simple",
      seed: 123,
    },
  });
}

function streamingStructuredAnthropicResponse(text: string): Response {
  const mid = Math.floor(text.length / 2);
  const chunks = [text.slice(0, mid), text.slice(mid)];
  const events = chunks.map((partialJson) => (
    `event: content_block_delta\n` +
    `data: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: partialJson },
    })}\n\n`
  ));

  return new Response(events.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
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
    if (body.stream) {
      return streamingStructuredAnthropicResponse(validToolCallJson());
    }

    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: validBuildJson() }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

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
  process.env.ANTHROPIC_STREAM_RESPONSES = "0";
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.ANTHROPIC_SONNET_5_EFFORT = "max";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("anthropic_claude_sonnet_5");

  assert.equal(model.provider, "anthropic");
  assert.equal(model.modelId, "claude-sonnet-5");
  assert.equal(model.displayName, "Claude Sonnet 5");
  assert.equal(model.openRouterModelId, "anthropic/claude-sonnet-5");
  assert.equal(MODEL_SLUG.anthropic_claude_sonnet_5, "sonnet-5");
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
  await generateVoxelBuild({
    modelKey: "anthropic_claude_sonnet_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { anthropic: "test-anthropic-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => directTraces.push(message),
  });

  const directRequest = capturedRequests.find((request) =>
    request.url.includes("api.anthropic.com"),
  );
  assert.ok(directRequest, "direct Anthropic request should be captured");
  assert.equal(directRequest.body.model, "claude-sonnet-5");
  assert.equal(directRequest.body.max_tokens, 128000);
  assert.equal(Object.hasOwn(directRequest.body, "temperature"), false);
  assert.equal(Object.hasOwn(directRequest.headers, "anthropic-beta"), false);
  assert.deepEqual(directRequest.body.thinking, { type: "adaptive" });
  assert.deepEqual((directRequest.body.output_config as { effort?: unknown })?.effort, "max");
  assert.ok(
    directTraces.some((trace) =>
      trace.includes("max_output_tokens=128000") &&
      trace.includes("adaptive_effort=max->xhigh->high->medium->low") &&
      trace.includes("temperature=default"),
    ),
    "direct trace should report the 128000-token cap, max adaptive effort fallback, and default sampling",
  );

  const openRouterTraces: string[] = [];
  await generateVoxelBuild({
    modelKey: "anthropic_claude_sonnet_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    preferOpenRouter: true,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => openRouterTraces.push(message),
  });

  const openRouterRequest = capturedRequests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(openRouterRequest, "OpenRouter request should be captured");
  assert.equal(openRouterRequest.model, "anthropic/claude-sonnet-5");
  assert.equal(openRouterRequest.max_tokens, 128000);
  assert.equal(Object.hasOwn(openRouterRequest, "temperature"), false);
  assert.deepEqual(openRouterRequest.reasoning, { effort: "max" });
  assert.ok(
    openRouterTraces.some((trace) =>
      trace.includes("max_output_tokens=128000") &&
      trace.includes("effort_fallback=max->xhigh->high->medium->low->disabled") &&
      trace.includes("temperature=default"),
    ),
    "OpenRouter trace should report the 128000-token cap, max reasoning fallback, and default sampling",
  );

  capturedRequests.length = 0;
  process.env.ANTHROPIC_SONNET_5_EFFORT = "low";
  const lowEffortTraces: string[] = [];
  await generateVoxelBuild({
    modelKey: "anthropic_claude_sonnet_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { anthropic: "test-anthropic-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => lowEffortTraces.push(message),
  });

  const lowEffortDirectRequest = capturedRequests.find((request) =>
    request.url.includes("api.anthropic.com"),
  );
  assert.ok(lowEffortDirectRequest, "low-effort direct Anthropic request should be captured");
  assert.deepEqual((lowEffortDirectRequest.body.output_config as { effort?: unknown })?.effort, "low");
  assert.ok(
    lowEffortTraces.some((trace) =>
      trace.includes("adaptive_effort=low") &&
      trace.includes("temperature=default"),
    ),
    "direct trace should report the Sonnet 5 env effort override",
  );

  process.env.ANTHROPIC_STREAM_RESPONSES = "1";
  const streamingResult = await generateVoxelBuild({
    modelKey: "anthropic_claude_sonnet_5",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: true,
    providerKeys: { anthropic: "test-anthropic-key" },
    allowServerKeys: false,
  });
  assert.equal(streamingResult.ok, true, "streamed Anthropic structured output should parse");
  if (streamingResult.ok) {
    assert.equal(streamingResult.blockCount, 1152);
  }

  console.log("claude sonnet 5 config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv.anthropicStreamResponses === undefined) {
      delete process.env.ANTHROPIC_STREAM_RESPONSES;
    } else {
      process.env.ANTHROPIC_STREAM_RESPONSES = originalEnv.anthropicStreamResponses;
    }
    if (originalEnv.maxOutputTokens === undefined) {
      delete process.env.MINEBENCH_MAX_OUTPUT_TOKENS;
    } else {
      process.env.MINEBENCH_MAX_OUTPUT_TOKENS = originalEnv.maxOutputTokens;
    }
    if (originalEnv.sonnet5Effort === undefined) {
      delete process.env.ANTHROPIC_SONNET_5_EFFORT;
    } else {
      process.env.ANTHROPIC_SONNET_5_EFFORT = originalEnv.sonnet5Effort;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
