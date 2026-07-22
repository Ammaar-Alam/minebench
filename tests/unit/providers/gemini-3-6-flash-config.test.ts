import assert from "node:assert/strict";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { getModelByKey, type ModelKey } from "../../../lib/ai/modelCatalog";
import {
  geminiThinkingConfigForModel,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { geminiGenerateText } from "../../../lib/ai/providers/gemini";
import { MODEL_KEY_BY_SLUG, MODEL_SLUG } from "../../../scripts/uploadsCatalog";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

type ExpectedModel = {
  key: ModelKey;
  modelId: string;
  displayName: string;
  openRouterModelId: string;
  slug: string;
};

const expectedModels: ExpectedModel[] = [
  {
    key: "gemini_3_6_flash",
    modelId: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    openRouterModelId: "google/gemini-3.6-flash",
    slug: "gemini-3-6-flash",
  },
  {
    key: "gemini_3_5_flash_lite",
    modelId: "gemini-3.5-flash-lite",
    displayName: "Gemini 3.5 Flash-Lite",
    openRouterModelId: "google/gemini-3.5-flash-lite",
    slug: "gemini-3-5-flash-lite",
  },
];

const capturedRequests: CapturedRequest[] = [];
let rejectDirectSchemaRequests = false;
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
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
  assert.ok(init?.body, "Provider request should include a JSON body");
  assert.equal(typeof init.body, "string", "Provider request body should be serialized JSON");

  const url = String(input);
  capturedRequests.push({
    url,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  });

  if (url.includes("generativelanguage.googleapis.com")) {
    if (rejectDirectSchemaRequests) {
      return new Response(
        JSON.stringify({ error: { message: "responseJsonSchema rejected" } }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: validBuildJson() }] } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return new Response(
    JSON.stringify({
      choices: [{ message: { content: validBuildJson() } }],
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

  for (const expected of expectedModels) {
    const model = getModelByKey(expected.key);

    assert.equal(model.provider, "gemini");
    assert.equal(model.modelId, expected.modelId);
    assert.equal(model.displayName, expected.displayName);
    assert.equal(model.enabled, true);
    assert.equal(model.openRouterModelId, expected.openRouterModelId);
    assert.equal(MODEL_SLUG[expected.key], expected.slug);
    assert.equal(MODEL_KEY_BY_SLUG[expected.slug], expected.key);
    assert.deepEqual(geminiThinkingConfigForModel(model.modelId), {
      thinkingLevel: "high",
    });
    assert.deepEqual(geminiThinkingConfigForModel(model.modelId, "minimal"), {
      thinkingLevel: "minimal",
    });
    assert.throws(
      () => geminiThinkingConfigForModel(model.modelId, "max"),
      /Supported values: high, medium, low, minimal/,
    );
    assert.deepEqual(openRouterReasoningEffortAttempts(expected.openRouterModelId), [
      "high",
      "medium",
      "low",
      "minimal",
    ]);

    const directTraces: string[] = [];
    await generateVoxelBuild({
      modelKey: expected.key,
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      enableTools: false,
      providerKeys: { gemini: "test-google-key" },
      allowServerKeys: false,
      onProviderTrace: (message) => directTraces.push(message),
    });

    const directRequest = capturedRequests.find((candidate) =>
      candidate.url.includes(`/models/${expected.modelId}:generateContent`),
    )?.body;
    assert.ok(directRequest, `Direct ${expected.displayName} request should be captured`);
    const generationConfig = directRequest.generationConfig as Record<string, unknown>;
    assert.equal(generationConfig.maxOutputTokens, 65536);
    assert.deepEqual(generationConfig.thinkingConfig, { thinkingLevel: "high" });
    assert.equal(Object.hasOwn(generationConfig, "thinkingBudget"), false);
    assert.equal(Object.hasOwn(generationConfig, "temperature"), false);
    assert.equal(generationConfig.responseMimeType, "application/json");
    assert.ok(generationConfig.responseJsonSchema, "Direct request should include the voxel schema");
    assert.ok(
      directTraces.some((trace) =>
        trace.includes(`Routing via direct gemini provider (${expected.modelId})`) &&
        trace.includes("max_output_tokens=65536") &&
        trace.includes("thinking_mode=thinking_level=high") &&
        trace.includes("temperature=default"),
      ),
      `Direct ${expected.displayName} trace should report the output cap and highest thinking level`,
    );

    const openRouterTraces: string[] = [];
    await generateVoxelBuild({
      modelKey: expected.key,
      prompt: "small tower",
      gridSize: 64,
      palette: "simple",
      enableTools: false,
      providerKeys: { openrouter: "test-openrouter-key" },
      allowServerKeys: false,
      onProviderTrace: (message) => openRouterTraces.push(message),
    });

    const openRouterRequest = capturedRequests.find(
      (candidate) => candidate.body.model === expected.openRouterModelId,
    )?.body;
    assert.ok(openRouterRequest, `OpenRouter ${expected.displayName} request should be captured`);
    assert.equal(openRouterRequest.max_tokens, 65536);
    assert.deepEqual(openRouterRequest.reasoning, { effort: "high" });
    assert.equal(Object.hasOwn(openRouterRequest, "temperature"), false);
    assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
    assert.equal(
      (openRouterRequest.response_format as { type?: unknown })?.type,
      "json_schema",
    );
    assert.equal(
      (
        openRouterRequest.response_format as {
          json_schema?: { strict?: unknown; schema?: unknown };
        }
      )?.json_schema?.strict,
      true,
    );
    assert.ok(
      (
        openRouterRequest.response_format as {
          json_schema?: { schema?: unknown };
        }
      )?.json_schema?.schema,
      "OpenRouter request should include the voxel schema",
    );
    assert.ok(
      openRouterTraces.some((trace) =>
        trace.includes(`Routing via OpenRouter (${expected.openRouterModelId})`) &&
        trace.includes("max_output_tokens=65536") &&
        trace.includes("effort_fallback=high->medium->low->minimal->disabled") &&
        trace.includes("temperature=default"),
      ),
      `OpenRouter ${expected.displayName} trace should report the output cap and highest reasoning effort`,
    );
  }

  rejectDirectSchemaRequests = true;
  const rejectedRequestStart = capturedRequests.length;
  console.error = () => {};
  try {
    await assert.rejects(
      geminiGenerateText({
        modelId: "gemini-3.6-flash",
        apiKey: "test-google-key",
        system: "Return JSON.",
        user: "small tower",
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingLevel: "high" },
        jsonSchema: { type: "object" },
      }),
      /Gemini request failed: Gemini error 400/,
    );
  } finally {
    console.error = originalConsoleError;
  }
  const rejectedRequests = capturedRequests.slice(rejectedRequestStart);
  assert.equal(
    rejectedRequests.length,
    1,
    "Gemini should not retry a terminal schema rejection",
  );
  assert.ok(
    rejectedRequests.every((request) => {
      const generationConfig = request.body.generationConfig as Record<string, unknown>;
      return (
        generationConfig.responseMimeType === "application/json" &&
        Boolean(generationConfig.responseJsonSchema)
      );
    }),
    "Gemini schema rejection should never launch a schema-less retry",
  );

  console.log("gemini 3.6 flash and 3.5 flash-lite config checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
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
