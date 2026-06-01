import assert from "node:assert/strict";
import {
  buildOpenRouterChatRequestBody,
  openRouterSupportedParametersFromEndpoints,
} from "../../../lib/ai/providers/openrouterRequest";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
  },
  required: ["ok"],
};

function main() {
  const opusCapabilities = openRouterSupportedParametersFromEndpoints({
    data: [
      {
        supported_parameters: [
          "max_tokens",
          "reasoning",
          "response_format",
          "tools",
          "verbosity",
        ],
      },
    ],
  });

  const opusSchemaRequest = buildOpenRouterChatRequestBody({
    modelId: "anthropic/claude-opus-4.8",
    messages: [
      { role: "system", content: "Return valid JSON." },
      { role: "user", content: "Build a small test shape." },
    ],
    stream: false,
    maxTokens: 128000,
    temperature: 0.2,
    explicitTemperature: true,
    jsonSchema: schema,
    reasoning: { effort: "max" },
    requireParameters: true,
    supportedParameters: opusCapabilities,
  });

  assert.equal(opusSchemaRequest.model, "anthropic/claude-opus-4.8");
  assert.equal(opusSchemaRequest.stream, false);
  assert.equal(opusSchemaRequest.max_tokens, 128000);
  assert.equal(Object.hasOwn(opusSchemaRequest, "temperature"), false);
  assert.deepEqual(opusSchemaRequest.provider, { require_parameters: true });
  assert.deepEqual(opusSchemaRequest.reasoning, { effort: "max" });
  assert.deepEqual(opusSchemaRequest.response_format, {
    type: "json_schema",
    json_schema: {
      name: "voxel_build_response",
      strict: true,
      schema,
    },
  });

  const nonStrictRequest = buildOpenRouterChatRequestBody({
    modelId: "openai/gpt-4.1",
    messages: [{ role: "user", content: "Say ok." }],
    stream: false,
    maxTokens: 512,
    temperature: 0.2,
    explicitTemperature: true,
    requireParameters: false,
  });

  assert.equal(nonStrictRequest.temperature, 0.2);

  const strictTemperatureSupportedRequest = buildOpenRouterChatRequestBody({
    modelId: "openai/gpt-4.1",
    messages: [{ role: "user", content: "Say ok." }],
    stream: false,
    maxTokens: 512,
    temperature: 0.4,
    explicitTemperature: true,
    requireParameters: true,
    supportedParameters: new Set(["max_tokens", "temperature"]),
  });

  assert.equal(strictTemperatureSupportedRequest.temperature, 0.4);

  console.log("openrouter request builder checks passed");
}

main();
