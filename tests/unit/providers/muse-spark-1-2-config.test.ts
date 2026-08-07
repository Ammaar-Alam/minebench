import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelBenchmarkProfile } from "../../../lib/ai/modelBenchmarkProfiles";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import { openRouterReasoningEffortAttempts } from "../../../lib/ai/reasoningProfiles";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
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
  assert.ok(init?.body, "OpenRouter request should include a JSON body");
  assert.equal(typeof init.body, "string", "OpenRouter request body should be serialized JSON");

  capturedRequests.push({
    url: String(input),
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  });

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
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("meta_muse_spark_1_2");
  assert.equal(model.provider, "meta");
  assert.equal(model.modelId, "muse-spark-1.2");
  assert.equal(model.displayName, "Muse Spark 1.2");
  assert.equal(model.openRouterModelId, "meta/muse-spark-1.2");
  assert.equal(model.forceOpenRouter, true);
  assert.equal(MODEL_SLUG.meta_muse_spark_1_2, "muse-spark-1-2");

  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), [
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
  ]);
  assert.deepEqual(
    openRouterReasoningEffortAttempts(model.openRouterModelId, "medium"),
    ["medium", "low", "minimal"],
  );
  assert.deepEqual(
    openRouterReasoningEffortAttempts(model.openRouterModelId, "minimal"),
    ["minimal"],
  );

  const profile = getModelBenchmarkProfile(model.key);
  assert.deepEqual(profile?.parameters, [
    { label: "Reasoning effort", value: "XHigh" },
  ]);

  const traces: string[] = [];
  const result = await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => traces.push(message),
  });
  assert.equal(result.providerRoute, "openrouter");
  assert.equal(result.acceptedOutputTokens, 131_072);

  const request = capturedRequests.find((candidate) =>
    candidate.url.includes("openrouter.test"),
  )?.body;
  assert.ok(request, "OpenRouter request should be captured");
  assert.equal(request.model, "meta/muse-spark-1.2");
  assert.equal(request.max_tokens, 131072);
  assert.deepEqual(request.reasoning, { effort: "xhigh" });
  assert.equal(request.temperature, 1);
  assert.deepEqual(request.provider, { require_parameters: true });

  const responseFormat = request.response_format as {
    type?: unknown;
    json_schema?: { name?: unknown; strict?: unknown; schema?: unknown };
  };
  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema?.name, "voxel_build_response");
  assert.equal(responseFormat.json_schema?.strict, true);
  assert.ok(responseFormat.json_schema?.schema);
  assert.ok(
    traces.some((trace) =>
      trace.includes("Routing via OpenRouter (meta/muse-spark-1.2)") &&
      trace.includes("max_output_tokens=131072") &&
      trace.includes(
        "effort_fallback=xhigh->high->medium->low->minimal->disabled",
      ) &&
      trace.includes("temperature=1"),
    ),
    "OpenRouter trace should report Muse Spark 1.2's output cap and effort ladder",
  );

  console.log("Muse Spark 1.2 config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv.maxOutputTokens === undefined) {
      delete process.env.MINEBENCH_MAX_OUTPUT_TOKENS;
    } else {
      process.env.MINEBENCH_MAX_OUTPUT_TOKENS = originalEnv.maxOutputTokens;
    }
    if (originalEnv.openRouterBaseUrl === undefined) {
      delete process.env.OPENROUTER_BASE_URL;
    } else {
      process.env.OPENROUTER_BASE_URL = originalEnv.openRouterBaseUrl;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
