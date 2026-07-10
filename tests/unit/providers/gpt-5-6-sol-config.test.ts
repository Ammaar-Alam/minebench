import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import { openAiReasoningEffortAttempts } from "../../../lib/ai/reasoningProfiles";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  useBackgroundMode: process.env.OPENAI_USE_BACKGROUND_MODE,
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
  assert.ok(init?.body, "OpenAI request should include a JSON body");
  assert.equal(typeof init.body, "string", "OpenAI request body should be serialized JSON");

  capturedRequests.push({
    url: String(input),
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  });

  return new Response(
    JSON.stringify({
      output_text: validBuildJson(),
      status: "completed",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}) as typeof fetch;

async function main() {
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "999999";
  process.env.OPENAI_USE_BACKGROUND_MODE = "0";

  const model = getModelByKey("openai_gpt_5_6_sol");

  assert.equal(model.provider, "openai");
  assert.equal(model.modelId, "gpt-5.6-sol");
  assert.equal(model.displayName, "GPT 5.6 Sol");
  assert.equal(model.openRouterModelId, undefined);
  assert.equal(MODEL_SLUG.openai_gpt_5_6_sol, "gpt-5-6-sol");
  assert.deepEqual(openAiReasoningEffortAttempts(model.modelId), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "none",
  ]);
  assert.deepEqual(openAiReasoningEffortAttempts(model.modelId, "max"), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "none",
  ]);

  const traces: string[] = [];
  await generateVoxelBuild({
    modelKey: "openai_gpt_5_6_sol",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { openai: "test-openai-key" },
    allowServerKeys: false,
    onProviderTrace: (message) => traces.push(message),
  });

  const request = capturedRequests.find((candidate) =>
    candidate.url.includes("api.openai.com/v1/responses"),
  )?.body;
  assert.ok(request, "OpenAI Responses request should be captured");
  assert.equal(request.model, "gpt-5.6-sol");
  assert.equal(request.max_output_tokens, 128000);
  assert.equal(Object.hasOwn(request, "temperature"), false);
  assert.deepEqual(request.reasoning, { effort: "max", mode: "pro" });
  assert.deepEqual((request.text as { verbosity?: unknown })?.verbosity, "high");
  assert.equal(
    ((request.text as { format?: { type?: unknown } })?.format)?.type,
    "json_schema",
  );
  assert.ok(
    traces.some((trace) =>
      trace.includes("max_output_tokens=128000") &&
      trace.includes("reasoning_effort_fallback=max->xhigh->high->medium->low->none->pro-default") &&
      trace.includes("reasoning_mode=pro") &&
      trace.includes("temperature=1"),
    ),
    "direct trace should report the output cap, max reasoning fallback, and pro mode",
  );

  console.log("gpt 5.6 sol config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv.maxOutputTokens === undefined) {
      delete process.env.MINEBENCH_MAX_OUTPUT_TOKENS;
    } else {
      process.env.MINEBENCH_MAX_OUTPUT_TOKENS = originalEnv.maxOutputTokens;
    }
    if (originalEnv.useBackgroundMode === undefined) {
      delete process.env.OPENAI_USE_BACKGROUND_MODE;
    } else {
      process.env.OPENAI_USE_BACKGROUND_MODE = originalEnv.useBackgroundMode;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
