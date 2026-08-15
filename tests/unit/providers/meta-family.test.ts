import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import {
  metaReasoningEffortAttempts,
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
} from "../../helpers/providerConfigHarness";

function assertStructuredOutput(body: Record<string, unknown>): void {
  const responseFormat = body.response_format as {
    type?: unknown;
    json_schema?: { name?: unknown; strict?: unknown; schema?: unknown };
  };
  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema?.name, "voxel_build_response");
  assert.equal(responseFormat.json_schema?.strict, true);
  assert.ok(responseFormat.json_schema?.schema);
}

runProviderConfigTest(
  "meta family",
  { META_MODEL_API_BASE_URL: undefined },
  async (capture) => {
    let rejectMetaStructuredOutput = false;
    let rejectOpenRouterEffortsAboveMinimal = false;

    capture.respondWith((request) => {
      const effort = (request.body.reasoning as { effort?: unknown } | undefined)?.effort;
      if (
        rejectOpenRouterEffortsAboveMinimal &&
        request.url.includes("openrouter.test") &&
        effort !== "minimal"
      ) {
        return jsonResponse({ error: { message: "reasoning effort unsupported" } }, 400);
      }
      return null;
    });

    // The direct Meta route goes through the SSRF-guarded node client, so it
    // needs a real local server plus pinned DNS instead of the fetch stub
    const metaServer = http.createServer(async (request, response) => {
      let rawBody = "";
      for await (const chunk of request) rawBody += chunk.toString();
      capture.requests.push({
        url: `https://${request.headers.host}${request.url}`,
        method: request.method ?? "POST",
        headers: { authorization: request.headers.authorization ?? "" },
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      response.setHeader("Content-Type", "application/json");
      if (rejectMetaStructuredOutput) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: validBuildJson() } }] }));
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
      await new Promise<void>((resolve) => metaServer.listen(0, "127.0.0.1", resolve));
      const address = metaServer.address();
      assert.ok(address && typeof address !== "string");
      process.env.META_MODEL_API_BASE_URL = `https://meta.test:${address.port}/v1`;

      const model = assertCatalogEntry({
        key: "meta_muse_spark_1_2",
        provider: "meta",
        modelId: "muse-spark-1.2",
        displayName: "Muse Spark 1.2",
        openRouterModelId: "meta/muse-spark-1.2",
        slug: "muse-spark-1-2",
      });
      assert.equal(modelRequiresReasoning(model.modelId), true);
      assert.equal(modelRequiresReasoning(model.openRouterModelId!), true);

      const effortLadder = ["xhigh", "high", "medium", "low", "minimal"];
      assert.deepEqual(metaReasoningEffortAttempts(model.modelId), effortLadder);
      assert.deepEqual(metaReasoningEffortAttempts(model.modelId, "medium"), [
        "medium",
        "low",
        "minimal",
      ]);
      assert.deepEqual(metaReasoningEffortAttempts(model.modelId, "minimal"), ["minimal"]);
      assert.throws(
        () => metaReasoningEffortAttempts(model.modelId, "none"),
        /Supported values: xhigh, high, medium, low, minimal\./,
      );
      assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId!), effortLadder);
      assert.throws(
        () => openRouterReasoningEffortAttempts(model.openRouterModelId!, "none"),
        /Supported values: xhigh, high, medium, low, minimal\./,
      );

      const profile = getModelBenchmarkProfile(model.key);
      assert.deepEqual(profile?.parameters, [{ label: "Reasoning effort", value: "XHigh" }]);

      const direct = await runGeneration(capture, {
        modelKey: model.key,
        maxAttempts: 1,
        providerKeys: { meta: "test-meta-key" },
      });
      assert.equal(direct.result.providerRoute, "direct");
      assert.equal(direct.result.acceptedOutputTokens, 131_072);
      const directRequest = direct.requests.find((candidate) =>
        candidate.url.includes("meta.test"),
      );
      assert.ok(directRequest, "Direct Meta Model API request should be captured");
      assert.equal(directRequest.url, `https://meta.test:${address.port}/v1/chat/completions`);
      assert.equal(directRequest.headers.authorization, "Bearer test-meta-key");
      assert.equal(directRequest.body.model, "muse-spark-1.2");
      assert.equal(directRequest.body.max_completion_tokens, 131_072);
      assert.equal("max_tokens" in directRequest.body, false);
      assert.equal(directRequest.body.reasoning_effort, "xhigh");
      assert.equal(directRequest.body.temperature, 1);
      assertStructuredOutput(directRequest.body);
      assertTraceLine(
        direct.traces,
        [
          "Routing via direct meta provider (muse-spark-1.2)",
          "max_output_tokens=131072",
          "thinking_mode=reasoning_effort=xhigh",
          "temperature=1",
        ],
        "Direct Meta trace should report xhigh reasoning and the output cap",
      );

      // A structured-output rejection is terminal, never retried schema-less
      rejectMetaStructuredOutput = true;
      const strictFailure = await runGeneration(capture, {
        modelKey: model.key,
        maxAttempts: 1,
        providerKeys: { meta: "test-meta-key" },
      });
      assert.equal(strictFailure.result.ok, false);
      assert.ok(!strictFailure.result.ok);
      assert.match(
        strictFailure.result.error,
        /Meta Model API error 400.*response_format unsupported/,
      );
      const strictFailureRequests = strictFailure.requests.filter((candidate) =>
        candidate.url.includes("meta.test"),
      );
      assert.equal(strictFailureRequests.length, 1, "Meta must not retry without response_format");
      assertStructuredOutput(strictFailureRequests[0].body);
      rejectMetaStructuredOutput = false;

      // Explicit OpenRouter preference wins over an available direct key
      const explicit = await runGeneration(capture, {
        modelKey: model.key,
        maxAttempts: 1,
        providerKeys: { meta: "test-meta-key", openrouter: "test-openrouter-key" },
      });
      assert.equal(explicit.result.providerRoute, "direct");
      const explicitOpenRouter = await runGeneration(capture, {
        modelKey: model.key,
        maxAttempts: 1,
        preferOpenRouter: true,
        providerKeys: { meta: "test-meta-key", openrouter: "test-openrouter-key" },
      });
      assert.equal(explicitOpenRouter.result.providerRoute, "openrouter");
      const explicitRequest = explicitOpenRouter.requests.find((candidate) =>
        candidate.url.includes("openrouter.test"),
      );
      assert.ok(explicitRequest, "Explicit OpenRouter request should be captured");
      assert.equal(explicitRequest.headers.authorization, "Bearer test-openrouter-key");
      assert.equal(explicitRequest.body.model, "meta/muse-spark-1.2");
      assert.deepEqual(explicitRequest.body.reasoning, { effort: "xhigh" });
      assertStructuredOutput(explicitRequest.body);

      // Mandatory reasoning: OpenRouter walks the ladder but never disables
      rejectOpenRouterEffortsAboveMinimal = true;
      const fallback = await runGeneration(capture, {
        modelKey: model.key,
        maxAttempts: 1,
        providerKeys: { openrouter: "test-openrouter-key" },
      });
      assert.equal(fallback.result.providerRoute, "openrouter");
      const fallbackRequests = fallback.requests.filter((candidate) =>
        candidate.url.includes("openrouter.test"),
      );
      assert.deepEqual(
        fallbackRequests.map(
          (candidate) => (candidate.body.reasoning as { effort?: unknown } | undefined)?.effort,
        ),
        effortLadder,
        "OpenRouter may lower Muse reasoning effort, but must never disable it",
      );
      assertTraceLine(
        fallback.traces,
        [
          "Routing via OpenRouter (meta/muse-spark-1.2)",
          "effort_fallback=xhigh->high->medium->low->minimal",
        ],
        "OpenRouter trace should expose the mandatory-reasoning fallback ladder",
        ["disabled"],
      );
    } finally {
      Object.defineProperty(dns, "lookup", { configurable: true, value: originalLookup });
      Object.defineProperty(https, "request", {
        configurable: true,
        value: originalHttpsRequest,
      });
      if (metaServer.listening) {
        await new Promise<void>((resolve, reject) => {
          metaServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  },
);
