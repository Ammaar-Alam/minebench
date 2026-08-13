import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import {
  openAiReasoningEffortAttempts,
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

// GPT 5.6 pro models share the full effort ladder and pro reasoning mode
const GPT_5_6_LADDER = ["max", "xhigh", "high", "medium", "low", "none"];

const PRO_EXPECTATIONS: ExpectedCatalogEntry[] = [
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

      assert.deepEqual(openAiReasoningEffortAttempts(model.modelId), GPT_5_6_LADDER);
      assert.deepEqual(openAiReasoningEffortAttempts(model.modelId, "max"), GPT_5_6_LADDER);
      assert.deepEqual(
        openRouterReasoningEffortAttempts(expected.openRouterModelId!),
        GPT_5_6_LADDER,
      );

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
          "reasoning_effort_fallback=max->xhigh->high->medium->low->none->pro-default",
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
          "effort_fallback=max->xhigh->high->medium->low->none->disabled",
          "temperature=default",
        ],
        `OpenRouter trace should report ${model.displayName}, its cap, and the max reasoning fallback`,
      );
    }

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
