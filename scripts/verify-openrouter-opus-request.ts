import assert from "node:assert/strict";
import { openrouterGenerateText } from "../lib/ai/providers/openrouter";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

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
            content: '{"ok":true}',
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
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  await openrouterGenerateText({
    modelId: "anthropic/claude-opus-4.8",
    apiKey: "test-openrouter-key",
    system: "Return valid JSON.",
    user: "Build a small test shape.",
    maxOutputTokens: 128000,
    temperature: 0.2,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
      },
      required: ["ok"],
    },
    reasoningEffortAttempts: ["max", "xhigh", "high"],
  });

  const opusRequest = capturedRequests[0]?.body;
  assert.ok(opusRequest, "Opus 4.8 request should be captured");
  assert.equal(opusRequest.model, "anthropic/claude-opus-4.8");
  assert.equal(Object.hasOwn(opusRequest, "temperature"), false);
  assert.equal(opusRequest.max_tokens, 128000);
  assert.deepEqual(opusRequest.reasoning, { effort: "max" });
  assert.deepEqual(opusRequest.provider, { require_parameters: true });
  assert.deepEqual(opusRequest.response_format, {
    type: "json_schema",
    json_schema: {
      name: "voxel_build_response",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
      },
    },
  });

  await openrouterGenerateText({
    modelId: "openai/gpt-4.1",
    apiKey: "test-openrouter-key",
    system: "Return text.",
    user: "Say ok.",
    maxOutputTokens: 512,
    temperature: 0.2,
  });

  const ordinaryRequest = capturedRequests[1]?.body;
  assert.ok(ordinaryRequest, "Ordinary OpenRouter request should be captured");
  assert.equal(ordinaryRequest.model, "openai/gpt-4.1");
  assert.equal(ordinaryRequest.temperature, 0.2);

  console.log("openrouter opus request checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
