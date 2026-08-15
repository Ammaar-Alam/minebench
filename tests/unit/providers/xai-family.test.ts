import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import {
  modelRequiresReasoning,
  openRouterReasoningEffortAttempts,
  xaiAutomaticReasoningForModel,
  xaiReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { xaiRequestConfigForModel } from "../../../lib/ai/providers/xai";
import { voxelExecToolCallJsonSchema } from "../../../lib/ai/tools/voxelExec";
import {
  assertCatalogEntry,
  assertTraceLine,
  installFetchCapture,
  jsonResponse,
  runGeneration,
  runProviderConfigTest,
  validBuildJson,
} from "../../helpers/providerConfigHarness";

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

runProviderConfigTest(
  "xai family",
  { XAI_BASE_URL: undefined },
  async (capture) => {
    let chatResponseText = validToolCallJson();
    capture.respondWith(() =>
      jsonResponse({ choices: [{ message: { content: chatResponseText } }] }),
    );

    // The direct xAI route goes through the SSRF-guarded node client, so it
    // needs a real local server plus pinned DNS instead of the fetch stub
    let rejectXaiStructuredOutput = false;
    let rejectXaiXhigh = false;
    const xaiServer = http.createServer(async (request, response) => {
      let rawBody = "";
      for await (const chunk of request) rawBody += chunk.toString();
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      capture.requests.push({
        url: `https://${request.headers.host}${request.url}`,
        method: request.method ?? "POST",
        headers: {},
        body,
      });
      response.setHeader("Content-Type", "application/json");
      if (rejectXaiXhigh && body.reasoning_effort === "xhigh") {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: "reasoning_effort xhigh unsupported" } }));
        return;
      }
      if (rejectXaiStructuredOutput) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: validToolCallJson() } }] }));
    });

    const originalLookup = dns.lookup;
    const originalHttpsRequest = https.request;
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

    try {
      await new Promise<void>((resolve) => xaiServer.listen(0, "127.0.0.1", resolve));
      const address = xaiServer.address();
      assert.ok(address && typeof address !== "string");
      process.env.XAI_BASE_URL = `https://xai.test:${address.port}/v1`;

      // Grok 4.6: explicit effort ladder, fixed reasoning, strict structured output
      const grok46 = assertCatalogEntry({
        key: "xai_grok_4_6",
        provider: "xai",
        modelId: "grok-4.6",
        displayName: "Grok 4.6",
        openRouterModelId: "x-ai/grok-4.6",
        slug: "grok-4-6",
      });
      assert.equal(modelRequiresReasoning(grok46.modelId), true);
      assert.equal(modelRequiresReasoning(grok46.openRouterModelId!), true);

      const grok46Ladder = ["xhigh", "high", "medium", "low"];
      assert.deepEqual(xaiReasoningEffortAttempts(grok46.modelId), grok46Ladder);
      assert.deepEqual(xaiReasoningEffortAttempts(grok46.modelId, "max"), grok46Ladder);
      assert.deepEqual(xaiReasoningEffortAttempts(grok46.modelId, "medium"), ["medium", "low"]);
      assert.deepEqual(
        openRouterReasoningEffortAttempts(grok46.openRouterModelId!),
        grok46Ladder,
      );
      assert.throws(
        () => xaiReasoningEffortAttempts(grok46.modelId, "none"),
        /Supported values: xhigh, high, medium, low\./,
      );
      assert.deepEqual(xaiRequestConfigForModel(grok46.modelId), {
        maxTokensParameter: "max_completion_tokens",
        reasoningEffort: "xhigh",
      });
      assert.deepEqual(getModelBenchmarkProfile(grok46.key)?.parameters, [
        { label: "Reasoning effort", value: "XHigh" },
        { label: "Sampling", value: "Provider default" },
      ]);

      const direct = await runGeneration(capture, {
        modelKey: grok46.key,
        maxAttempts: 1,
        enableTools: true,
        providerKeys: { xai: "test-xai-key" },
      });
      assert.equal(direct.result.providerRoute, "direct");
      assert.equal(direct.result.acceptedOutputTokens, 496_000);
      const directRequest = direct.requests.find((candidate) =>
        candidate.url.includes("xai.test"),
      );
      assert.ok(directRequest, "Direct xAI request should be captured");
      assert.equal(directRequest.body.model, "grok-4.6");
      assert.equal(directRequest.body.max_completion_tokens, 496_000);
      assert.equal("max_tokens" in directRequest.body, false);
      assert.equal(directRequest.body.reasoning_effort, "xhigh");
      assert.equal("temperature" in directRequest.body, false);
      assertStructuredOutput(directRequest.body);
      assertTraceLine(
        direct.traces,
        [
          "Routing via direct xai provider (grok-4.6)",
          "max_output_tokens=496000",
          "thinking_mode=reasoning_effort=xhigh",
          "temperature=default",
        ],
        "Grok 4.6 direct trace should report the cap and xhigh reasoning",
      );

      // An xhigh rejection steps down the ladder within one attempt
      rejectXaiXhigh = true;
      const fallback = await runGeneration(capture, {
        modelKey: grok46.key,
        maxAttempts: 1,
        enableTools: true,
        providerKeys: { xai: "test-xai-key" },
      });
      assert.equal(fallback.result.acceptedOutputTokens, 496_000);
      assert.deepEqual(
        fallback.requests
          .filter((request) => request.url.includes("xai.test"))
          .map((request) => request.body.reasoning_effort),
        ["xhigh", "high"],
      );
      assertTraceLine(
        fallback.traces,
        ["xAI reasoning config 'xhigh' rejected", "falling back to 'high'"],
        "Grok 4.6 should trace the effort fallback",
      );
      rejectXaiXhigh = false;

      const openRouter = await runGeneration(capture, {
        modelKey: grok46.key,
        maxAttempts: 1,
        enableTools: true,
        providerKeys: { openrouter: "test-openrouter-key" },
      });
      assert.equal(openRouter.result.providerRoute, "openrouter");
      const openRouterRequest = openRouter.requests.find((candidate) =>
        candidate.url.includes("openrouter.test"),
      );
      assert.ok(openRouterRequest, "OpenRouter request should be captured");
      assert.equal(openRouterRequest.body.model, "x-ai/grok-4.6");
      assert.equal(openRouterRequest.body.max_tokens, 496_000);
      assert.deepEqual(openRouterRequest.body.reasoning, { effort: "xhigh" });
      assert.equal("temperature" in openRouterRequest.body, false);
      assert.deepEqual(openRouterRequest.body.provider, { require_parameters: true });
      assertStructuredOutput(openRouterRequest.body);
      assertTraceLine(
        openRouter.traces,
        [
          "Routing via OpenRouter (x-ai/grok-4.6)",
          "effort_fallback=xhigh->high->medium->low",
          "temperature=default",
        ],
        "Grok 4.6 OpenRouter trace should report the effort fallback without disabling",
        ["disabled"],
      );

      // A structured-output rejection is terminal, never retried schema-less
      rejectXaiStructuredOutput = true;
      const strictFailure = await runGeneration(capture, {
        modelKey: grok46.key,
        maxAttempts: 1,
        enableTools: true,
        providerKeys: { xai: "test-xai-key" },
      });
      assert.equal(strictFailure.result.ok, false);
      assert.ok(!strictFailure.result.ok);
      assert.match(strictFailure.result.error, /xAI error 400.*response_format unsupported/);
      const strictFailureRequests = strictFailure.requests.filter((request) =>
        request.url.includes("xai.test"),
      );
      assert.equal(
        strictFailureRequests.length,
        1,
        "Grok 4.6 must not retry without response_format",
      );
      assertStructuredOutput(strictFailureRequests[0].body);
      rejectXaiStructuredOutput = false;

      // Grok 4.5: no xhigh, context-bounded cap, MineBench temperature applies
      chatResponseText = validBuildJson();
      const grok45 = assertCatalogEntry({
        key: "xai_grok_4_5",
        provider: "xai",
        modelId: "grok-4.5",
        displayName: "Grok 4.5",
        openRouterModelId: "x-ai/grok-4.5",
        slug: "grok-4-5",
      });
      assert.deepEqual(xaiReasoningEffortAttempts(grok45.modelId), ["high", "medium", "low"]);
      assert.deepEqual(xaiReasoningEffortAttempts(grok45.modelId, "max"), [
        "high",
        "medium",
        "low",
      ]);
      assert.deepEqual(xaiReasoningEffortAttempts(grok45.modelId, "medium"), ["medium", "low"]);
      assert.equal(
        xaiReasoningEffortAttempts("grok-4.3", "automatic"),
        undefined,
        "automatic xAI models should bypass the explicit effort helper",
      );
      assert.equal(
        xaiAutomaticReasoningForModel("grok-4.3", "automatic"),
        "automatic",
        "Grok 4.3 should preserve its automatic reasoning override",
      );
      assert.deepEqual(openRouterReasoningEffortAttempts(grok45.openRouterModelId!), [
        "high",
        "medium",
        "low",
      ]);
      assert.deepEqual(xaiRequestConfigForModel(grok45.modelId), {
        maxTokensParameter: "max_completion_tokens",
        reasoningEffort: "high",
      });

      const grok45Traces: string[] = [];
      await generateVoxelBuild({
        modelKey: "xai_grok_4_5",
        prompt: "small tower",
        gridSize: 64,
        palette: "simple",
        enableTools: false,
        preferOpenRouter: true,
        providerKeys: { openrouter: "test-openrouter-key" },
        allowServerKeys: false,
        onProviderTrace: (message) => grok45Traces.push(message),
      });
      const grok45Request = capture.requests
        .filter((candidate) => candidate.url.includes("openrouter.test"))
        .at(-1)?.body;
      assert.ok(grok45Request, "OpenRouter request should be captured");
      assert.equal(grok45Request.model, "x-ai/grok-4.5");
      assert.equal(grok45Request.max_tokens, 500_000);
      assert.deepEqual(grok45Request.reasoning, { effort: "high" });
      assert.equal(
        (grok45Request.response_format as { json_schema?: { strict?: unknown } })?.json_schema
          ?.strict,
        true,
      );
      assertTraceLine(
        grok45Traces,
        [
          "max_output_tokens=500000",
          "effort_fallback=high->medium->low->disabled",
          "temperature=1",
        ],
        "Grok 4.5 OpenRouter trace should report the context-bounded cap and highest reasoning effort",
      );
    } finally {
      Object.defineProperty(dns, "lookup", { configurable: true, value: originalLookup });
      Object.defineProperty(https, "request", {
        configurable: true,
        value: originalHttpsRequest,
      });
      await new Promise<void>((resolve) => xaiServer.close(() => resolve()));
    }
  },
);
