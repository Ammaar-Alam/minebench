import assert from "node:assert/strict";
import {
  geminiThinkingConfigForModel,
  modelRequiresReasoning,
  openRouterReasoningEffortAttempts,
} from "../../../lib/ai/reasoningProfiles";
import { geminiGenerateText } from "../../../lib/ai/providers/gemini";
import { voxelExecToolCallJsonSchema } from "../../../lib/ai/tools/voxelExec";
import {
  assertCatalogEntry,
  assertTraceLine,
  installFetchCapture,
  jsonResponse,
  runGeneration,
  runProviderConfigTest,
  schemaContainsKey,
  type ExpectedCatalogEntry,
} from "../../helpers/providerConfigHarness";

// One record per Gemini flash model on the arena roster
// effortAttempts is the OpenRouter descent ladder, highest first
type GeminiExpectation = {
  catalog: ExpectedCatalogEntry;
  effortAttempts: string[];
  unsupportedEffort: { value: string; message: RegExp };
  minimalSupported: boolean;
  requiresReasoning: boolean;
  effortFallbackTrace: string;
};

const EXPECTATIONS: GeminiExpectation[] = [
  {
    catalog: {
      key: "gemini_3_8_flash",
      provider: "gemini",
      modelId: "gemini-3.8-flash",
      displayName: "Gemini 3.8 Flash",
      openRouterModelId: "google/gemini-3.8-flash",
      slug: "gemini-3-8-flash",
    },
    effortAttempts: ["high", "medium", "low"],
    unsupportedEffort: { value: "minimal", message: /Supported values: high, medium, low/ },
    minimalSupported: false,
    requiresReasoning: true,
    effortFallbackTrace: "effort_fallback=high->medium->low",
  },
  {
    catalog: {
      key: "gemini_3_7_flash",
      provider: "gemini",
      modelId: "gemini-3.7-flash",
      displayName: "Gemini 3.7 Flash",
      openRouterModelId: "google/gemini-3.7-flash",
      slug: "gemini-3-7-flash",
    },
    effortAttempts: ["high", "medium", "low"],
    unsupportedEffort: { value: "minimal", message: /Supported values: high, medium, low/ },
    minimalSupported: false,
    requiresReasoning: true,
    effortFallbackTrace: "effort_fallback=high->medium->low",
  },
  {
    catalog: {
      key: "gemini_3_6_flash",
      provider: "gemini",
      modelId: "gemini-3.6-flash",
      displayName: "Gemini 3.6 Flash",
      openRouterModelId: "google/gemini-3.6-flash",
      slug: "gemini-3-6-flash",
    },
    effortAttempts: ["high", "medium", "low", "minimal"],
    unsupportedEffort: { value: "max", message: /Supported values: high, medium, low, minimal/ },
    minimalSupported: true,
    requiresReasoning: false,
    effortFallbackTrace: "effort_fallback=high->medium->low->minimal->disabled",
  },
  {
    catalog: {
      key: "gemini_3_5_flash_lite",
      provider: "gemini",
      modelId: "gemini-3.5-flash-lite",
      displayName: "Gemini 3.5 Flash-Lite",
      openRouterModelId: "google/gemini-3.5-flash-lite",
      slug: "gemini-3-5-flash-lite",
    },
    effortAttempts: ["high", "medium", "low", "minimal"],
    unsupportedEffort: { value: "max", message: /Supported values: high, medium, low, minimal/ },
    minimalSupported: true,
    requiresReasoning: false,
    effortFallbackTrace: "effort_fallback=high->medium->low->minimal->disabled",
  },
];

runProviderConfigTest("gemini family", {}, async (capture) => {
  for (const expected of EXPECTATIONS) {
    const model = assertCatalogEntry(expected.catalog);

    assert.deepEqual(geminiThinkingConfigForModel(model.modelId), { thinkingLevel: "high" });
    if (expected.minimalSupported) {
      assert.deepEqual(geminiThinkingConfigForModel(model.modelId, "minimal"), {
        thinkingLevel: "minimal",
      });
    }
    assert.throws(
      () => geminiThinkingConfigForModel(model.modelId, expected.unsupportedEffort.value),
      expected.unsupportedEffort.message,
    );
    assert.deepEqual(
      openRouterReasoningEffortAttempts(expected.catalog.openRouterModelId!),
      expected.effortAttempts,
    );
    assert.equal(
      modelRequiresReasoning(expected.catalog.openRouterModelId!),
      expected.requiresReasoning,
    );

    const direct = await runGeneration(capture, {
      modelKey: expected.catalog.key,
      maxAttempts: 1,
      providerKeys: { gemini: "test-google-key" },
    });
    const directRequest = direct.requests.find((candidate) =>
      candidate.url.includes(`/models/${model.modelId}:generateContent`),
    )?.body;
    assert.ok(directRequest, `Direct ${model.displayName} request should be captured`);
    const generationConfig = directRequest.generationConfig as Record<string, unknown>;
    assert.equal(generationConfig.maxOutputTokens, 65_536);
    assert.deepEqual(generationConfig.thinkingConfig, { thinkingLevel: "high" });
    assert.equal(Object.hasOwn(generationConfig, "thinkingBudget"), false);
    assert.equal(Object.hasOwn(generationConfig, "temperature"), false);
    assert.equal(generationConfig.responseMimeType, "application/json");
    assert.ok(generationConfig.responseJsonSchema, "Direct request should include the voxel schema");
    assert.equal(
      schemaContainsKey(generationConfig.responseJsonSchema, "minLength"),
      false,
      "Direct request should remove JSON Schema keywords unsupported by Gemini",
    );
    assert.equal(
      schemaContainsKey(generationConfig.responseJsonSchema, "minItems"),
      true,
      "Direct request should preserve Gemini-supported array constraints",
    );
    assertTraceLine(
      direct.traces,
      [
        `Routing via direct gemini provider (${model.modelId})`,
        "max_output_tokens=65536",
        "thinking_mode=thinking_level=high",
        "temperature=default",
      ],
      `Direct ${model.displayName} trace should report the output cap and highest thinking level`,
    );

    const openRouter = await runGeneration(capture, {
      modelKey: expected.catalog.key,
      maxAttempts: 1,
      providerKeys: { openrouter: "test-openrouter-key" },
    });
    const openRouterRequest = openRouter.requests.find(
      (candidate) => candidate.body.model === expected.catalog.openRouterModelId,
    )?.body;
    assert.ok(openRouterRequest, `OpenRouter ${model.displayName} request should be captured`);
    assert.equal(openRouterRequest.max_tokens, 65_536);
    assert.deepEqual(openRouterRequest.reasoning, { effort: "high" });
    assert.equal(Object.hasOwn(openRouterRequest, "temperature"), false);
    assert.deepEqual(openRouterRequest.provider, { require_parameters: true });
    assert.deepEqual(
      openRouterRequest.response_format,
      { type: "json_object" },
      `OpenRouter ${model.displayName} should avoid broken Google schema translation`,
    );
    assertTraceLine(
      openRouter.traces,
      [
        `Routing via OpenRouter (${expected.catalog.openRouterModelId})`,
        "max_output_tokens=65536",
        expected.effortFallbackTrace,
        "temperature=default",
      ],
      `OpenRouter ${model.displayName} trace should report the output cap and highest reasoning effort`,
      expected.requiresReasoning ? ["disabled"] : [],
    );
  }

  const overridden = await runGeneration(capture, {
    modelKey: "gemini_3_8_flash",
    maxAttempts: 1,
    providerKeys: { gemini: "test-google-key" },
    customHeaders: { "X-Request-Profile": "low-thinking" },
    customBody: {
      generationConfig: {
        thinkingConfig: { thinkingLevel: "low" },
        responseMimeType: "text/plain",
        responseJsonSchema: { type: "string" },
      },
    },
  });
  const overriddenRequest = overridden.requests.find((request) =>
    request.url.includes("generativelanguage.googleapis.com"),
  );
  assert.ok(overriddenRequest);
  assert.equal(overriddenRequest.headers["x-request-profile"], "low-thinking");
  const overriddenConfig = overriddenRequest.body.generationConfig as Record<string, unknown>;
  assert.deepEqual(overriddenConfig.thinkingConfig, { thinkingLevel: "low" });
  assert.equal(overriddenConfig.responseMimeType, "application/json");
  assert.notDeepEqual(overriddenConfig.responseJsonSchema, { type: "string" });

  // Gemini 3.0 Flash keeps its exact provider output limit
  const gemini30 = await runGeneration(capture, {
    modelKey: "gemini_3_0_flash",
    providerKeys: { gemini: "test-google-key" },
  });
  const gemini30Request = gemini30.requests.find((candidate) =>
    candidate.url.includes("/models/gemini-3-flash-preview:generateContent"),
  )?.body;
  assert.ok(gemini30Request, "Gemini 3.0 Flash request should be captured");
  assert.equal(
    (gemini30Request.generationConfig as Record<string, unknown>).maxOutputTokens,
    65_536,
    "Gemini 3.0 Flash should use its exact provider output limit",
  );

  // Schema sanitization strips unsupported keywords without mutating the shared schema
  const toolSchema = voxelExecToolCallJsonSchema();
  assert.equal(schemaContainsKey(toolSchema, "minLength"), true);
  const toolRequestStart = capture.requests.length;
  await geminiGenerateText({
    modelId: "gemini-3.6-flash",
    apiKey: "test-google-key",
    system: "Return a tool call.",
    user: "small tower",
    maxOutputTokens: 65536,
    thinkingConfig: { thinkingLevel: "high" },
    jsonSchema: toolSchema as unknown as Record<string, unknown>,
  });
  const toolRequest = capture.requests[toolRequestStart]?.body;
  assert.ok(toolRequest, "Direct Gemini tool-schema request should be captured");
  const toolGenerationConfig = toolRequest.generationConfig as Record<string, unknown>;
  assert.equal(
    schemaContainsKey(toolGenerationConfig.responseJsonSchema, "minLength"),
    false,
    "Direct tool schema should remove unsupported Gemini keywords",
  );
  assert.equal(
    schemaContainsKey(toolSchema, "minLength"),
    true,
    "Gemini schema sanitization should not mutate the shared tool schema",
  );

  const openRouterToolModels = [
    ...EXPECTATIONS.map((expected) => expected.catalog),
    {
      key: "gemma_4_31b" as const,
      displayName: "Gemma 4 31B",
      openRouterModelId: "google/gemma-4-31b-it",
    },
  ];
  for (const model of openRouterToolModels) {
    const openRouterTool = await runGeneration(capture, {
      modelKey: model.key,
      maxAttempts: 1,
      enableTools: true,
      providerKeys: { openrouter: "test-openrouter-key" },
    });
    const openRouterToolRequest = openRouterTool.requests.find(
      (request) => request.body.model === model.openRouterModelId,
    )?.body;
    assert.ok(
      openRouterToolRequest,
      `OpenRouter ${model.displayName} tool-schema request should be captured`,
    );
    if (model.openRouterModelId?.startsWith("google/gemini-")) {
      assert.deepEqual(
        openRouterToolRequest.response_format,
        { type: "json_object" },
        `OpenRouter ${model.displayName} tool mode should avoid broken Google schema translation`,
      );
      continue;
    }
    const openRouterToolFormat = openRouterToolRequest.response_format as {
      json_schema?: { schema?: unknown };
    };
    assert.deepEqual(
      openRouterToolFormat.json_schema?.schema,
      toolGenerationConfig.responseJsonSchema,
      `OpenRouter ${model.displayName} should receive the direct Gemini schema`,
    );
  }
  assert.equal(
    schemaContainsKey(toolSchema, "minLength"),
    true,
    "OpenRouter Gemini schema sanitization should not mutate the shared tool schema",
  );

  // A terminal schema rejection is not retried and never drops the schema
  capture.respondWith((request) =>
    request.url.includes("generativelanguage.googleapis.com")
      ? jsonResponse({ error: { message: "responseJsonSchema rejected" } }, 400)
      : null,
  );
  const rejectedRequestStart = capture.requests.length;
  const originalConsoleError = console.error;
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
    capture.respondWith(null);
  }
  const rejectedRequests = capture.requests.slice(rejectedRequestStart);
  assert.equal(rejectedRequests.length, 1, "Gemini should not retry a terminal schema rejection");
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
});
