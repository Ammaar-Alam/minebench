import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import {
  anthropicAdaptiveEffortAttempts,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import {
  assertCatalogEntry,
  assertTraceLine,
  installFetchCapture,
  jsonResponse,
  runGeneration,
  runProviderConfigTest,
  validBuildJson,
  type ExpectedCatalogEntry,
} from "../../helpers/providerConfigHarness";

// Claude 5 releases share the full adaptive ladder and default-only sampling
const FULL_LADDER = ["max", "xhigh", "high", "medium", "low"];

const EXPECTATIONS: ExpectedCatalogEntry[] = [
  {
    key: "anthropic_claude_fable_5",
    provider: "anthropic",
    modelId: "claude-fable-5",
    displayName: "Claude Fable 5",
    openRouterModelId: "anthropic/claude-fable-5",
    slug: "claude-fable-5",
  },
  {
    key: "anthropic_claude_opus_5",
    provider: "anthropic",
    modelId: "claude-opus-5",
    displayName: "Claude Opus 5",
    openRouterModelId: "anthropic/claude-opus-5",
    slug: "opus-5",
  },
  {
    key: "anthropic_claude_sonnet_5",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    openRouterModelId: "anthropic/claude-sonnet-5",
    slug: "sonnet-5",
  },
];

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
  const events = [text.slice(0, mid), text.slice(mid)].map(
    (partialJson) =>
      `event: content_block_delta\n` +
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partialJson },
      })}\n\n`,
  );
  return new Response(events.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

runProviderConfigTest(
  "anthropic family",
  {
    ANTHROPIC_STREAM_RESPONSES: "0",
    ANTHROPIC_OPUS_5_EFFORT: "max",
    ANTHROPIC_SONNET_5_EFFORT: "max",
  },
  async (capture) => {
    // Scenario scripting: queued response texts and a one-shot max-effort rejection
    const queuedResponseTexts: string[] = [];
    let rejectAnthropicMaxOnce = false;
    capture.respondWith((request) => {
      if (request.url.includes("api.anthropic.com")) {
        const effort = (request.body.output_config as { effort?: unknown } | undefined)?.effort;
        if (rejectAnthropicMaxOnce && effort === "max") {
          rejectAnthropicMaxOnce = false;
          return jsonResponse(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "output_config.effort max is unsupported",
              },
            },
            400,
          );
        }
        if (request.body.stream) {
          return streamingStructuredAnthropicResponse(validToolCallJson());
        }
        const responseText = queuedResponseTexts.shift() ?? validBuildJson();
        return jsonResponse({ content: [{ type: "text", text: responseText }] });
      }
      const responseText = queuedResponseTexts.shift() ?? validBuildJson();
      return jsonResponse({ choices: [{ message: { content: responseText } }] });
    });

    for (const expected of EXPECTATIONS) {
      const model = assertCatalogEntry(expected);

      assert.deepEqual(anthropicAdaptiveEffortAttempts(model.modelId), FULL_LADDER);
      assert.deepEqual(anthropicAdaptiveEffortAttempts(model.modelId, "xhigh"), [
        "xhigh",
        "high",
        "medium",
        "low",
      ]);
      assert.deepEqual(
        openRouterReasoningEffortAttempts(expected.openRouterModelId!),
        FULL_LADDER,
      );

      const direct = await runGeneration(capture, {
        modelKey: expected.key,
        maxAttempts: 1,
        providerKeys: { anthropic: "test-anthropic-key" },
      });
      const directRequest = direct.requests.find((request) =>
        request.url.includes("api.anthropic.com"),
      );
      assert.ok(directRequest, `direct ${model.displayName} request should be captured`);
      assert.equal(directRequest.body.model, model.modelId);
      assert.equal(directRequest.body.max_tokens, 128_000);
      assert.equal(Object.hasOwn(directRequest.headers, "anthropic-beta"), false);
      assert.equal(directRequest.headers["anthropic-version"], "2023-06-01");
      assert.equal(Object.hasOwn(directRequest.body, "temperature"), false);
      assert.equal(Object.hasOwn(directRequest.body, "top_p"), false);
      assert.equal(Object.hasOwn(directRequest.body, "top_k"), false);
      assert.deepEqual(directRequest.body.thinking, { type: "adaptive" });
      assert.equal(
        (directRequest.body.output_config as { effort?: unknown })?.effort,
        "max",
      );
      assertTraceLine(
        direct.traces,
        [
          "max_output_tokens=128000",
          "adaptive_effort=max->xhigh->high->medium->low",
          "temperature=default",
        ],
        `direct ${model.displayName} trace should report the 128000-token cap, max adaptive effort fallback, and default sampling`,
      );

      const openRouter = await runGeneration(capture, {
        modelKey: expected.key,
        maxAttempts: 1,
        providerKeys: { openrouter: "test-openrouter-key" },
      });
      const openRouterRequest = openRouter.requests.find((request) =>
        request.url.includes("openrouter.test"),
      )?.body;
      assert.ok(openRouterRequest, `OpenRouter ${model.displayName} request should be captured`);
      assert.equal(openRouterRequest.model, expected.openRouterModelId);
      assert.equal(openRouterRequest.max_tokens, 128_000);
      assert.equal(Object.hasOwn(openRouterRequest, "temperature"), false);
      assert.equal(Object.hasOwn(openRouterRequest, "top_p"), false);
      assert.equal(Object.hasOwn(openRouterRequest, "top_k"), false);
      assert.deepEqual(openRouterRequest.reasoning, { effort: "max" });
      assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
      const responseFormat = openRouterRequest.response_format as {
        type?: unknown;
        json_schema?: { strict?: unknown };
      };
      assert.equal(responseFormat.type, "json_schema");
      assert.equal(responseFormat.json_schema?.strict, true);
      assertTraceLine(
        openRouter.traces,
        [
          "max_output_tokens=128000",
          "effort_fallback=max->xhigh->high->medium->low->disabled",
          "temperature=default",
        ],
        `OpenRouter ${model.displayName} trace should report the 128000-token cap, max reasoning fallback, and default sampling`,
      );
    }

    // Opus 5 benchmark profile pins the published cohort facts
    const opusProfile = getModelBenchmarkProfile("anthropic_claude_opus_5");
    assert.ok(opusProfile, "Claude Opus 5 should have benchmark details");
    assert.deepEqual(opusProfile.parameters, [
      { label: "Thinking", value: "Adaptive" },
      { label: "Reasoning effort", value: "Max" },
      { label: "Sampling", value: "Provider default" },
    ]);
    assert.deepEqual(opusProfile.outputCap, { kind: "exact", tokens: 128_000 });
    assert.deepEqual(opusProfile.averageInference, { milliseconds: 1_930_169 });
    assert.equal(opusProfile.averageJsonSizeBytes, 95_421_017);
    assert.deepEqual(opusProfile.totalCost, { usd: 89.97, attemptCount: 37 });
    assert.equal(opusProfile.totalAttempts, 37);
    assert.equal(opusProfile.buildCount, 15);

    // Telemetry callbacks stay outside inference timing; raw responses and
    // provider-request callbacks fire once per attempt
    const directTraces: string[] = [];
    const directAttempts: number[] = [];
    const directRawResponses: Array<{ attempt: number; rawText: string }> = [];
    const callbackDelayMs = 75;
    const delayedCallbackCount = 5;
    const callbackWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
    queuedResponseTexts.push("not valid JSON", validBuildJson());
    const directWallStartedAt = performance.now();
    const directResult = await generateVoxelBuild({
      modelKey: "anthropic_claude_opus_5",
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      maxAttempts: 2,
      enableTools: false,
      providerKeys: { anthropic: "test-anthropic-key" },
      allowServerKeys: false,
      onProviderRequest: (attempt) => {
        Atomics.wait(callbackWaitBuffer, 0, 0, callbackDelayMs);
        directAttempts.push(attempt);
      },
      onRawResponse: (attempt, rawText) => {
        Atomics.wait(callbackWaitBuffer, 0, 0, callbackDelayMs);
        directRawResponses.push({ attempt, rawText });
      },
      onRetry: () => {
        Atomics.wait(callbackWaitBuffer, 0, 0, callbackDelayMs);
      },
      onProviderTrace: (message) => directTraces.push(message),
    });
    const directWallTimeMs = performance.now() - directWallStartedAt;

    assert.equal(directResult.acceptedOutputTokens, 128_000);
    assert.ok(
      directWallTimeMs - directResult.generationTimeMs >=
        callbackDelayMs * delayedCallbackCount - 40,
      "synchronous telemetry callbacks must stay outside inference timing",
    );
    assert.equal(
      directResult.requestConfiguration,
      "Request config: api_mode=messages, max_output_tokens=128000, reasoning_max_tokens=n/a, thinking_mode=adaptive_effort=max, temperature=default, text_verbosity=default, response_format=json_schema.",
    );
    assert.deepEqual(directRawResponses, [
      { attempt: 1, rawText: "not valid JSON" },
      { attempt: 2, rawText: validBuildJson() },
    ]);
    assert.deepEqual(directAttempts, [1, 2]);

    // A max-effort rejection steps down the adaptive ladder within one attempt
    rejectAnthropicMaxOnce = true;
    const fallbackRequests: number[] = [];
    queuedResponseTexts.push(validLargeBuildJson());
    const fallbackStart = capture.requests.length;
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
      capture.requests
        .slice(fallbackStart)
        .map((request) => (request.body.output_config as { effort?: unknown } | undefined)?.effort),
      ["max", "xhigh"],
    );
    assert.equal(
      fallbackResult.requestConfiguration,
      "Request config: api_mode=messages, max_output_tokens=128000, reasoning_max_tokens=n/a, thinking_mode=adaptive_effort=xhigh, temperature=default, text_verbosity=default, response_format=json_schema.",
    );

    // A missing key fails before any request or retry fires
    const missingKeyAttempts: number[] = [];
    const missingKeyRetries: number[] = [];
    const missingKeyStart = capture.requests.length;
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
    assert.equal(capture.requests.length, missingKeyStart);

    // An unsupported reasoning override fails before any request fires
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
    assert.equal(capture.requests.length, missingKeyStart);

    // OpenRouter route reports the accepted configuration
    queuedResponseTexts.push(validBuildJson());
    const opusOpenRouterTraces: string[] = [];
    const opusOpenRouterResult = await generateVoxelBuild({
      modelKey: "anthropic_claude_opus_5",
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      maxAttempts: 1,
      enableTools: false,
      preferOpenRouter: true,
      providerKeys: { openrouter: "test-openrouter-key" },
      allowServerKeys: false,
      onProviderTrace: (message) => opusOpenRouterTraces.push(message),
    });
    assert.equal(opusOpenRouterResult.acceptedOutputTokens, 128_000);
    assert.ok(
      opusOpenRouterResult.requestConfiguration?.includes("thinking_mode=reasoning=max"),
    );

    // Env effort overrides lower the starting effort on both routes
    process.env.ANTHROPIC_OPUS_5_EFFORT = "low";
    assert.deepEqual(
      openRouterReasoningEffortAttempts("anthropic/claude-opus-5"),
      ["low"],
    );
    queuedResponseTexts.push(validBuildJson());
    const opusLow = await runGeneration(capture, {
      modelKey: "anthropic_claude_opus_5",
      maxAttempts: 1,
      providerKeys: { anthropic: "test-anthropic-key" },
    });
    const opusLowRequest = opusLow.requests.find((request) =>
      request.url.includes("api.anthropic.com"),
    );
    assert.ok(opusLowRequest, "low-effort direct Anthropic request should be captured");
    assert.equal(
      (opusLowRequest.body.output_config as { effort?: unknown }).effort,
      "low",
    );

    process.env.ANTHROPIC_SONNET_5_EFFORT = "low";
    const sonnetLow = await runGeneration(capture, {
      modelKey: "anthropic_claude_sonnet_5",
      maxAttempts: 1,
      providerKeys: { anthropic: "test-anthropic-key" },
    });
    const sonnetLowRequest = sonnetLow.requests.find((request) =>
      request.url.includes("api.anthropic.com"),
    );
    assert.ok(sonnetLowRequest, "low-effort direct Anthropic request should be captured");
    assert.equal(
      (sonnetLowRequest.body.output_config as { effort?: unknown })?.effort,
      "low",
    );
    assertTraceLine(
      sonnetLow.traces,
      ["adaptive_effort=low", "temperature=default"],
      "direct trace should report the Sonnet 5 env effort override",
    );

    const sonnetLowOpenRouter = await runGeneration(capture, {
      modelKey: "anthropic_claude_sonnet_5",
      maxAttempts: 1,
      providerKeys: { openrouter: "test-openrouter-key" },
    });
    const sonnetLowOpenRouterRequest = sonnetLowOpenRouter.requests.find((request) =>
      request.url.includes("openrouter.test"),
    )?.body;
    assert.ok(sonnetLowOpenRouterRequest, "low-effort OpenRouter request should be captured");
    assert.deepEqual(sonnetLowOpenRouterRequest.reasoning, { effort: "low" });
    assertTraceLine(
      sonnetLowOpenRouter.traces,
      ["effort_fallback=low->disabled", "temperature=default"],
      "OpenRouter trace should report the Sonnet 5 env effort override",
    );

    // Streamed structured output parses tool calls from SSE deltas
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
  },
);
