import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import {
  openAiReasoningEffortAttempts,
  modelRequiresReasoning,
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

// OpenAI pro models use max effort and pro reasoning mode for benchmark runs
const GPT_5_6_LADDER = ["max", "xhigh", "high", "medium", "low", "none"];
const GPT_6_ASTRA_LADDER = ["max", "xhigh", "high", "medium", "low"];

const PRO_EXPECTATIONS: ExpectedCatalogEntry[] = [
  {
    key: "openai_gpt_6_astra",
    provider: "openai",
    modelId: "gpt-6-astra",
    displayName: "GPT 6 Astra Pro",
    openRouterModelId: "openai/gpt-6-astra-pro",
    slug: "gpt-6-astra",
  },
  {
    key: "openai_gpt_5_6_luna",
    provider: "openai",
    modelId: "gpt-5.6-luna",
    displayName: "GPT 5.6 Luna Pro",
    openRouterModelId: "openai/gpt-5.6-luna-pro",
    slug: "gpt-5-6-luna",
  },
  {
    key: "openai_gpt_5_6_sol",
    provider: "openai",
    modelId: "gpt-5.6-sol",
    displayName: "GPT 5.6 Sol Pro",
    openRouterModelId: "openai/gpt-5.6-sol-pro",
    slug: "gpt-5-6-sol",
  },
];

runProviderConfigTest(
  "openai family",
  { OPENAI_USE_BACKGROUND_MODE: "0" },
  async (capture) => {
    capture.respondWith((request) => {
      if (request.url.includes("/chat/completions")) {
        return jsonResponse({ choices: [{ message: { content: validBuildJson() } }] });
      }
      if (request.body.stream === true) {
        const event = JSON.stringify({
          type: "response.output_text.done",
          text: validBuildJson(),
        });
        return new Response(`data: ${event}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return jsonResponse({ output_text: validBuildJson(), status: "completed" });
    });

    for (const expected of PRO_EXPECTATIONS) {
      const model = assertCatalogEntry(expected);

      const ladder = model.modelId === "gpt-6-astra" ? GPT_6_ASTRA_LADDER : GPT_5_6_LADDER;
      assert.deepEqual(openAiReasoningEffortAttempts(model.modelId), ladder);
      assert.deepEqual(openAiReasoningEffortAttempts(model.modelId, "max"), ladder);
      assert.deepEqual(openRouterReasoningEffortAttempts(expected.openRouterModelId!), ladder);

      const direct = await runGeneration(capture, {
        modelKey: expected.key,
        maxAttempts: 1,
        providerKeys: { openai: "test-openai-key" },
      });
      assert.equal(direct.result.acceptedOutputTokens, 128_000);
      assert.equal(direct.result.providerRoute, "direct");
      assert.ok(
        direct.result.requestConfiguration?.includes("api_mode=responses_sync"),
        "synchronous Responses runs should record their execution mode",
      );
      const directRequest = direct.requests.find((candidate) =>
        candidate.url.includes("api.openai.com/v1/responses"),
      )?.body;
      assert.ok(directRequest, "OpenAI Responses request should be captured");
      assert.equal(directRequest.model, model.modelId);
      assert.equal(directRequest.max_output_tokens, 128_000);
      assert.equal(Object.hasOwn(directRequest, "temperature"), false);
      assert.deepEqual(directRequest.reasoning, { effort: "max", mode: "pro" });
      assert.deepEqual((directRequest.text as { verbosity?: unknown })?.verbosity, "high");
      assert.equal(
        (directRequest.text as { format?: { type?: unknown } })?.format?.type,
        "json_schema",
      );
      assertTraceLine(
        direct.traces,
        [
          `Routing via direct openai provider (${model.modelId})`,
          "max_output_tokens=128000",
          `reasoning_effort_fallback=${ladder.join("->")}->pro-default`,
          "reasoning_mode=pro",
          "temperature=default",
        ],
        `direct trace should report ${model.displayName}'s cap, pro mode, max reasoning fallback, and default sampling`,
      );

      const openRouter = await runGeneration(capture, {
        modelKey: expected.key,
        maxAttempts: 1,
        providerKeys: { openrouter: "test-openrouter-key" },
      });
      assert.equal(openRouter.result.acceptedOutputTokens, 128_000);
      assert.equal(openRouter.result.providerRoute, "openrouter");
      const openRouterRequest = openRouter.requests.find((candidate) =>
        candidate.url.includes("/chat/completions"),
      )?.body;
      assert.ok(openRouterRequest, "OpenRouter request should be captured");
      assert.equal(openRouterRequest.model, expected.openRouterModelId);
      assert.equal(openRouterRequest.max_tokens, 128_000);
      assert.deepEqual(openRouterRequest.reasoning, { effort: "max" });
      assert.equal(Object.hasOwn(openRouterRequest, "temperature"), false);
      assert.equal(Object.hasOwn(openRouterRequest, "text"), false);
      assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
      const responseFormat = openRouterRequest.response_format as {
        type?: unknown;
        json_schema?: { strict?: unknown; schema?: unknown };
      };
      assert.equal(responseFormat?.type, "json_schema");
      assert.equal(responseFormat?.json_schema?.strict, true);
      assert.ok(
        responseFormat?.json_schema?.schema,
        "OpenRouter request should include the voxel schema",
      );
      assertTraceLine(
        openRouter.traces,
        [
          `Routing via OpenRouter (${expected.openRouterModelId})`,
          "max_output_tokens=128000",
          `effort_fallback=${ladder.join("->")}${model.modelId === "gpt-6-astra" ? "" : "->disabled"}`,
          "temperature=default",
        ],
        `OpenRouter trace should report ${model.displayName}, its cap, and the max reasoning fallback`,
      );
    }

    for (const effort of ["none", "minimal"]) {
      assert.throws(() => openAiReasoningEffortAttempts("gpt-6-astra", effort), /does not support/);
      assert.throws(() => openRouterReasoningEffortAttempts("openai/gpt-6-astra-pro", effort), /does not support/);
    }
    assert.equal(modelRequiresReasoning("openai/gpt-6-astra-pro"), true);
    const rejectedStart = capture.requests.length;
    capture.respondWith(() => jsonResponse({ error: { message: "Model access denied" } }, 403));
    const rejectedAstra = await runGeneration(capture, {
      modelKey: "openai_gpt_6_astra",
      maxAttempts: 1,
      providerKeys: { openai: "test-openai-key", openrouter: "test-openrouter-key" },
    });
    assert.equal(rejectedAstra.result.ok, false);
    assert.ok(capture.requests.slice(rejectedStart).every((request) => request.url.endsWith("/responses")));
    capture.respondWith(null);

    const overridden = await runGeneration(capture, {
      modelKey: "openai_gpt_5_6_sol",
      maxAttempts: 1,
      providerKeys: { openai: "test-openai-key" },
      customHeaders: { "X-Request-Profile": "low-effort" },
      customBody: {
        background: true,
        reasoning: { effort: "low" },
        store: true,
        text: { verbosity: "low", format: { type: "text" } },
      },
    });
    const overriddenRequest = overridden.requests.find((request) =>
      request.url.includes("api.openai.com/v1/responses"),
    );
    assert.ok(overriddenRequest);
    assert.equal(overriddenRequest.headers["x-request-profile"], "low-effort");
    assert.equal(Object.hasOwn(overriddenRequest.body, "background"), false);
    assert.equal(Object.hasOwn(overriddenRequest.body, "store"), false);
    assert.deepEqual(overriddenRequest.body.reasoning, { effort: "low", mode: "pro" });
    assert.equal(
      (overriddenRequest.body.text as { verbosity?: unknown }).verbosity,
      "low",
    );
    assert.equal(
      (overriddenRequest.body.text as { format?: { type?: unknown } }).format?.type,
      "json_schema",
      "custom tuning must not replace MineBench's output schema",
    );
    const routedOverride = await runGeneration(capture, {
      modelKey: "openai_gpt_5_6_sol",
      maxAttempts: 1,
      providerKeys: { openrouter: "test-openrouter-key" },
      customHeaders: { "X-Request-Profile": "router-low" },
      customBody: {
        reasoning: { effort: "low" },
        provider: { order: ["OpenAI"], require_parameters: false },
      },
    });
    const routedOverrideRequest = routedOverride.requests.find((request) =>
      request.url.includes("/chat/completions"),
    );
    assert.ok(routedOverrideRequest);
    assert.equal(routedOverrideRequest.headers["x-request-profile"], "router-low");
    assert.deepEqual(routedOverrideRequest.body.reasoning, { effort: "low" });
    assert.deepEqual(routedOverrideRequest.body.provider, {
      order: ["OpenAI"],
      require_parameters: true,
    });

    // Background and streamed Responses runs record distinct execution modes
    const syncResult = await generateVoxelBuild({
      modelKey: "openai_gpt_5_6_sol",
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      enableTools: false,
      providerKeys: { openai: "test-openai-key" },
      allowServerKeys: false,
    });
    assert.ok(syncResult.requestConfiguration?.includes("api_mode=responses_sync"));

    process.env.OPENAI_USE_BACKGROUND_MODE = "1";
    const backgroundStart = capture.requests.length;
    const backgroundResult = await generateVoxelBuild({
      modelKey: "openai_gpt_5_6_sol",
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      enableTools: false,
      providerKeys: { openai: "test-openai-key" },
      allowServerKeys: false,
    });
    assert.ok(
      backgroundResult.requestConfiguration?.includes("api_mode=responses_background"),
      "background Responses runs should record their execution mode",
    );
    assert.notEqual(
      backgroundResult.requestConfiguration,
      syncResult.requestConfiguration,
      "background and synchronous runs must not share a benchmark fingerprint",
    );
    const backgroundRequest = capture.requests
      .slice(backgroundStart)
      .find(
        (candidate) =>
          candidate.url.includes("api.openai.com/v1/responses") &&
          candidate.body.background === true,
      )?.body;
    assert.ok(backgroundRequest, "OpenAI background request should be captured");
    assert.equal(backgroundRequest.store, true);
    process.env.OPENAI_USE_BACKGROUND_MODE = "0";

    const streamedResult = await generateVoxelBuild({
      modelKey: "openai_gpt_5_6_sol",
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      enableTools: false,
      providerKeys: { openai: "test-openai-key" },
      allowServerKeys: false,
      onDelta: () => undefined,
    });
    assert.ok(
      streamedResult.requestConfiguration?.includes("api_mode=responses_stream"),
      "streamed Responses runs should record their execution mode",
    );
    assert.notEqual(
      streamedResult.requestConfiguration,
      syncResult.requestConfiguration,
      "streamed and synchronous runs must not share a benchmark fingerprint",
    );

    // Import-only web harness model never reaches a provider
    const webHarness = assertCatalogEntry({
      key: "openai_gpt_4_5_web_harness",
      provider: "openai",
      modelId: "gpt-4.5-preview",
      displayName: "GPT 4.5 (web harness)",
      openRouterModelId: undefined,
      slug: "gpt-4-5-web-harness",
      enabled: false,
      importOnly: true,
    });
    assert.equal(webHarness.importOnly, true);
    const importOnlyStart = capture.requests.length;
    const importOnlyResult = await generateVoxelBuild({
      modelKey: "openai_gpt_4_5_web_harness",
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      enableTools: false,
      providerKeys: { openai: "test-openai-key" },
      allowServerKeys: false,
    });
    assert.equal(importOnlyResult.ok, false);
    assert.match(importOnlyResult.error, /import-only/i);
    assert.match(importOnlyResult.error, /web harness JSON/i);
    assert.equal(capture.requests.length, importOnlyStart);
  },
);
