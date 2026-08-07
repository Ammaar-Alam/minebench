import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  metaReasoningEffortAttempts,
  modelRequiresReasoning,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  metaBaseUrl: process.env.META_MODEL_API_BASE_URL,
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL,
};
let rejectOpenRouterEffortsAboveMinimal = false;

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

  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  capturedRequests.push({
    url: String(input),
    authorization: new Headers(init.headers).get("Authorization"),
    body,
  });

  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort;
  if (
    rejectOpenRouterEffortsAboveMinimal &&
    String(input).includes("openrouter.test") &&
    effort !== "minimal"
  ) {
    return new Response(
      JSON.stringify({ error: { message: "reasoning effort unsupported" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
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
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.META_MODEL_API_BASE_URL = "https://meta.test/v1";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("meta_muse_spark_1_2");
  assert.equal(model.provider, "meta");
  assert.equal(model.modelId, "muse-spark-1.2");
  assert.equal(model.displayName, "Muse Spark 1.2");
  const openRouterModelId = model.openRouterModelId;
  assert.equal(openRouterModelId, "meta/muse-spark-1.2");
  assert.ok(openRouterModelId);
  assert.equal(model.forceOpenRouter, undefined);
  assert.equal(MODEL_SLUG.meta_muse_spark_1_2, "muse-spark-1-2");
  assert.equal(modelRequiresReasoning(model.modelId), true);
  assert.equal(modelRequiresReasoning(openRouterModelId), true);

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
  assert.deepEqual(openRouterReasoningEffortAttempts(openRouterModelId), effortLadder);
  assert.throws(
    () => openRouterReasoningEffortAttempts(openRouterModelId, "none"),
    /Supported values: xhigh, high, medium, low, minimal\./,
  );

  const profile = getModelBenchmarkProfile(model.key);
  assert.deepEqual(profile?.parameters, [
    { label: "Reasoning effort", value: "XHigh" },
  ]);

  const directTraces: string[] = [];
  const directResult = await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    providerKeys: { meta: "test-meta-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => directTraces.push(message),
  });
  assert.equal(directResult.providerRoute, "direct");
  assert.equal(directResult.acceptedOutputTokens, 131_072);

  const directRequest = capturedRequests.find((candidate) =>
    candidate.url.includes("meta.test"),
  );
  assert.ok(directRequest, "Direct Meta Model API request should be captured");
  assert.equal(directRequest.url, "https://meta.test/v1/chat/completions");
  assert.equal(directRequest.authorization, "Bearer test-meta-key");
  assert.equal(directRequest.body.model, "muse-spark-1.2");
  assert.equal(directRequest.body.max_completion_tokens, 131072);
  assert.equal("max_tokens" in directRequest.body, false);
  assert.equal(directRequest.body.reasoning_effort, "xhigh");
  assert.equal(directRequest.body.temperature, 1);
  assertStructuredOutput(directRequest.body);
  assert.ok(
    directTraces.some((trace) =>
      trace.includes("Routing via direct meta provider (muse-spark-1.2)") &&
      trace.includes("max_output_tokens=131072") &&
      trace.includes("thinking_mode=reasoning_effort=xhigh") &&
      trace.includes("temperature=1"),
    ),
    "Direct Meta trace should report xhigh reasoning and the output cap",
  );

  const explicitOpenRouterStart = capturedRequests.length;
  const explicitOpenRouterResult = await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    preferOpenRouter: true,
    providerKeys: {
      meta: "test-meta-key",
      openrouter: "test-openrouter-key",
    },
    allowServerKeys: false,
  });
  assert.equal(explicitOpenRouterResult.providerRoute, "openrouter");

  const explicitOpenRouterRequest = capturedRequests
    .slice(explicitOpenRouterStart)
    .find((candidate) => candidate.url.includes("openrouter.test"));
  assert.ok(explicitOpenRouterRequest, "Explicit OpenRouter request should be captured");
  assert.equal(explicitOpenRouterRequest.authorization, "Bearer test-openrouter-key");
  assert.equal(explicitOpenRouterRequest.body.model, "meta/muse-spark-1.2");
  assert.deepEqual(explicitOpenRouterRequest.body.reasoning, { effort: "xhigh" });
  assertStructuredOutput(explicitOpenRouterRequest.body);

  rejectOpenRouterEffortsAboveMinimal = true;
  const fallbackStart = capturedRequests.length;
  const fallbackTraces: string[] = [];
  const fallbackResult = await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 1,
    enableTools: false,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => fallbackTraces.push(message),
  });
  assert.equal(fallbackResult.providerRoute, "openrouter");

  const fallbackRequests = capturedRequests
    .slice(fallbackStart)
    .filter((candidate) => candidate.url.includes("openrouter.test"));
  assert.deepEqual(
    fallbackRequests.map(
      (candidate) =>
        (candidate.body.reasoning as { effort?: unknown } | undefined)?.effort,
    ),
    effortLadder,
    "OpenRouter may lower Muse reasoning effort, but must never disable it",
  );
  assert.ok(
    fallbackTraces.some((trace) =>
      trace.includes("Routing via OpenRouter (meta/muse-spark-1.2)") &&
      trace.includes("effort_fallback=xhigh->high->medium->low->minimal") &&
      !trace.includes("disabled"),
    ),
    "OpenRouter trace should expose the mandatory-reasoning fallback ladder",
  );

  console.log("Muse Spark 1.2 config checks passed");
}

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

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      MINEBENCH_MAX_OUTPUT_TOKENS: originalEnv.maxOutputTokens,
      META_MODEL_API_BASE_URL: originalEnv.metaBaseUrl,
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
