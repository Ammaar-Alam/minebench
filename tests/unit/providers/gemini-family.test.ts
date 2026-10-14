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
  validBuildJson,
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

  const argon = assertCatalogEntry({
    key: "gemini_4_argon",
    provider: "gemini",
    modelId: "gemini-4-argon",
    displayName: "Gemini 4 Argon",
    openRouterModelId: "google/gemini-4-argon",
    slug: "gemini-4-argon",
  });
  assert.deepEqual(geminiThinkingConfigForModel(argon.modelId), { thinkingLevel: "high" });
  assert.throws(
    () => geminiThinkingConfigForModel(argon.modelId, "minimal"),
    /Supported values: high, medium, low/,
  );
  assert.deepEqual(openRouterReasoningEffortAttempts(argon.openRouterModelId!), [
    "high",
    "medium",
    "low",
  ]);
  assert.equal(modelRequiresReasoning(argon.openRouterModelId!), true);

  // Long decode resends the identical request with each continuation token
  const build = validBuildJson();
  const hops = [
    { text: build.slice(0, 20), finishReason: "CONTINUATION", continuationToken: "hop-1" },
    { text: build.slice(20, 40), finishReason: "CONTINUATION", continuationToken: "hop-2" },
    { text: build.slice(40), finishReason: "STOP" },
  ];
  let hopIndex = 0;
  capture.respondWith((request) => {
    if (!request.url.includes("/models/gemini-4-argon:")) return null;
    const { text, finishReason, continuationToken } = hops[hopIndex++];
    // Thought summaries keep the stream active and never reach the build text, and
    // the terminal reason and token may arrive on separate events
    const events = [
      { candidates: [{ content: { parts: [{ text: "planning", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text }] }, finishReason }] },
      ...(continuationToken ? [{ candidates: [{ continuationToken }] }] : []),
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const argonRun = await runGeneration(capture, {
    modelKey: argon.key,
    maxAttempts: 1,
    providerKeys: { gemini: "test-google-key" },
  });
  capture.respondWith(null);
  assert.equal(argonRun.result.rawText, build, "Continuation hops should join into one response");
  // Argon always streams so long hops return headers before undici's timeout
  const argonRequests = argonRun.requests.filter((request) =>
    request.url.includes("/models/gemini-4-argon:streamGenerateContent"),
  );
  assert.equal(argonRequests.length, 3);
  assert.deepEqual(
    argonRequests.map((request) => request.body.continuationToken),
    [undefined, "hop-1", "hop-2"],
  );
  const { continuationToken: _token, ...resumedBody } = argonRequests[2].body;
  assert.deepEqual(resumedBody, argonRequests[0].body);
  const argonConfig = argonRequests[0].body.generationConfig as Record<string, unknown>;
  assert.deepEqual(argonConfig.thinkingConfig, { thinkingLevel: "high", includeThoughts: true });
  assert.equal(Object.hasOwn(argonConfig, "temperature"), false);
  assertTraceLine(
    argonRun.traces,
    [
      "Routing via direct gemini provider (gemini-4-argon)",
      "thinking_mode=thinking_level=high",
      "temperature=default",
    ],
    "Direct Gemini 4 Argon trace should report the highest thinking level",
  );

  // A dropped stream resumes from its last checkpoint and drops the uncommitted text
  const sse = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  const droppedChunks = [
    sse({ candidates: [{ content: { parts: [{ text: build.slice(0, 30) }] }, continuationToken: "checkpoint-1" }] }),
    sse({ candidates: [{ content: { parts: [{ text: "uncommitted" }] } }] }),
  ];
  const resumedDeltas: string[] = [];
  let resumeRequests = 0;
  const resumeResponder = (request: { url: string }) => {
    if (!request.url.includes("/models/gemini-4-argon:")) return null;
    if (resumeRequests++ === 0) {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = droppedChunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.error(new Error("socket reset"));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return new Response(
      new TextDecoder().decode(
        sse({ candidates: [{ content: { parts: [{ text: build.slice(30) }] }, finishReason: "STOP" }] }),
      ),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  capture.respondWith(resumeResponder);
  const resumed = await runGeneration(capture, {
    modelKey: argon.key,
    maxAttempts: 1,
    providerKeys: { gemini: "test-google-key" },
  });
  capture.respondWith(null);
  assert.equal(resumed.result.rawText, build, "Resumed text should drop output after the checkpoint");

  // Streamed deltas never include text that a resume later discards
  resumeRequests = 0;
  droppedChunks.push(
    sse({ candidates: [{ content: { parts: [{ text: build.slice(0, 30) }] }, continuationToken: "checkpoint-1" }] }),
    sse({ candidates: [{ content: { parts: [{ text: "uncommitted" }] } }] }),
  );
  capture.respondWith(resumeResponder);
  await geminiGenerateText({
    modelId: "gemini-4-argon",
    apiKey: "test-google-key",
    system: "Return a build.",
    user: "small tower",
    maxOutputTokens: 1_048_576,
    thinkingConfig: { thinkingLevel: "high" },
    jsonSchema: { type: "object" },
    onDelta: (delta) => resumedDeltas.push(delta),
  });
  capture.respondWith(null);
  assert.equal(resumedDeltas.join(""), build);

  // A continuation request that fails to connect also retries from the checkpoint
  resumeRequests = 0;
  droppedChunks.push(
    sse({ candidates: [{ content: { parts: [{ text: build.slice(0, 30) }] }, continuationToken: "checkpoint-1" }] }),
    sse({ candidates: [{ content: { parts: [{ text: "uncommitted" }] } }] }),
  );
  let failedConnects = 0;
  capture.respondWith((request) => {
    if (request.url.includes("/models/gemini-4-argon:") && resumeRequests === 1 && failedConnects++ === 0) {
      throw new TypeError("fetch failed");
    }
    return resumeResponder(request);
  });
  const reconnected = await runGeneration(capture, {
    modelKey: argon.key,
    maxAttempts: 1,
    providerKeys: { gemini: "test-google-key" },
  });
  capture.respondWith(null);
  assert.equal(reconnected.result.rawText, build);
  assert.deepEqual(
    reconnected.requests
      .filter((request) => request.url.includes("/models/gemini-4-argon:"))
      .map((request) => request.body.continuationToken),
    [undefined, "checkpoint-1", "checkpoint-1"],
  );
  assert.deepEqual(
    resumed.requests
      .filter((request) => request.url.includes("/models/gemini-4-argon:"))
      .map((request) => request.body.continuationToken),
    [undefined, "checkpoint-1"],
  );

  // A socket error after STOP keeps the finished build instead of discarding it
  const finishedChunks = [
    sse({ candidates: [{ content: { parts: [{ text: build }] }, finishReason: "STOP" }] }),
  ];
  capture.respondWith((request) =>
    request.url.includes("/models/gemini-4-argon:")
      ? new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = finishedChunks.shift();
              if (chunk) controller.enqueue(chunk);
              else controller.error(new Error("socket reset"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      : null,
  );
  const closedAfterStop = await runGeneration(capture, {
    modelKey: argon.key,
    maxAttempts: 1,
    providerKeys: { gemini: "test-google-key" },
  });
  capture.respondWith(null);
  assert.equal(closedAfterStop.result.rawText, build);
  assert.equal(
    closedAfterStop.requests.filter((request) => request.url.includes("/models/gemini-4-argon:")).length,
    1,
  );

  // A stream that closes without a final event is a cut-off response, never an empty build
  capture.respondWith((request) =>
    request.url.includes("/models/gemini-4-argon:")
      ? new Response(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "planning", thought: true }] } }] })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        )
      : null,
  );
  const cutOff = await runGeneration(capture, {
    modelKey: argon.key,
    maxAttempts: 1,
    providerKeys: { gemini: "test-google-key" },
  });
  capture.respondWith(null);
  assert.ok(!cutOff.result.ok);
  assert.match(cutOff.result.error, /Gemini stream ended before completion \(finishReason=none\)/);

  // A finished stream holding only thought summaries has no build to return
  capture.respondWith((request) =>
    request.url.includes("/models/gemini-4-argon:")
      ? new Response(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "planning", thought: true }] }, finishReason: "STOP" }] })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        )
      : null,
  );
  const thoughtOnly = await runGeneration(capture, {
    modelKey: argon.key,
    maxAttempts: 1,
    providerKeys: { gemini: "test-google-key" },
  });
  capture.respondWith(null);
  assert.ok(!thoughtOnly.result.ok);
  assert.match(thoughtOnly.result.error, /Gemini returned no answer text \(finishReason=STOP\)/);

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
