import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey } from "../../../lib/ai/modelCatalog";
import {
  moonshotThinkingConfigForModel,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
  maxOutputTokens: process.env.MINEBENCH_MAX_OUTPUT_TOKENS,
  moonshotBaseUrl: process.env.MOONSHOT_BASE_URL,
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
  assert.equal(typeof init?.body, "string");
  capturedRequests.push({
    url: String(input),
    body: JSON.parse(init?.body as string) as Record<string, unknown>,
  });
  return new Response(
    JSON.stringify({ choices: [{ message: { content: validBuildJson() } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

async function main() {
  process.env.MINEBENCH_MAX_OUTPUT_TOKENS = "262144";
  process.env.MOONSHOT_BASE_URL = "https://moonshot.test";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const model = getModelByKey("moonshot_kimi_k3");
  assert.equal(model.modelId, "kimi-k3");
  assert.equal(model.openRouterModelId, "moonshotai/kimi-k3");
  assert.equal(MODEL_SLUG.moonshot_kimi_k3, "kimi-k3");
  assert.deepEqual(moonshotThinkingConfigForModel(model.modelId), {
    reasoningEffort: "max",
  });
  assert.throws(() => moonshotThinkingConfigForModel(model.modelId, "disabled"));
  assert.deepEqual(openRouterReasoningEffortAttempts(model.openRouterModelId), ["max"]);

  await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    providerKeys: { moonshot: "test-moonshot-key" },
    allowServerKeys: false,
  });
  await generateVoxelBuild({
    modelKey: model.key,
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    enableTools: false,
    preferOpenRouter: true,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
  });

  const direct = capturedRequests.find((request) => request.url.includes("moonshot.test"))?.body;
  assert.ok(direct);
  assert.equal(direct.model, "kimi-k3");
  assert.equal(direct.max_completion_tokens, 262144);
  assert.equal(direct.reasoning_effort, "max");
  assert.equal("thinking" in direct, false);
  assert.equal("temperature" in direct, false);
  assert.equal("top_p" in direct, false);
  assert.equal(
    ((direct.response_format as { json_schema?: { strict?: unknown } })?.json_schema)?.strict,
    true,
  );

  const openRouter = capturedRequests.find((request) =>
    request.url.includes("openrouter.test"),
  )?.body;
  assert.ok(openRouter);
  assert.equal(openRouter.model, "moonshotai/kimi-k3");
  assert.equal(openRouter.max_tokens, 262144);
  assert.deepEqual(openRouter.reasoning, { effort: "max" });
  assert.equal("temperature" in openRouter, false);

  console.log("kimi k3 config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      MINEBENCH_MAX_OUTPUT_TOKENS: originalEnv.maxOutputTokens,
      MOONSHOT_BASE_URL: originalEnv.moonshotBaseUrl,
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
