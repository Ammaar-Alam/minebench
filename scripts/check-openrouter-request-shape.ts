import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOpenRouterChatRequestBody,
  type OpenRouterSupportedParameter,
  openRouterSupportedParametersFromEndpoints,
} from "@/lib/ai/providers/openrouterRequest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixturePath = join(
  __dirname,
  "fixtures/openrouter/anthropic-claude-opus-4.8-endpoints.json",
);

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
const supportedParameters = openRouterSupportedParametersFromEndpoints(fixture);

const requestBody = buildOpenRouterChatRequestBody({
  modelId: "anthropic/claude-opus-4.8",
  messages: [
    { role: "system", content: "Return valid JSON." },
    { role: "user", content: "Build a small 16x16 stone arch with two pillars and a flat base." },
  ],
  stream: false,
  maxTokens: 128000,
  temperature: 0.2,
  explicitTemperature: true,
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      version: { type: "string" },
      blocks: { type: "array" },
    },
    required: ["version", "blocks"],
  },
  reasoning: { effort: "max" },
  requireParameters: true,
  supportedParameters,
});

function providerParameterNames(body: Record<string, unknown>): OpenRouterSupportedParameter[] {
  const names: OpenRouterSupportedParameter[] = [];
  if (Object.hasOwn(body, "max_tokens")) names.push("max_tokens");
  if (Object.hasOwn(body, "reasoning")) names.push("reasoning");
  if (Object.hasOwn(body, "response_format")) names.push("response_format");
  if (Object.hasOwn(body, "temperature")) names.push("temperature");
  if (Object.hasOwn(body, "tools")) names.push("tools");
  if (Object.hasOwn(body, "tool_choice")) names.push("tool_choice");
  if (Object.hasOwn(body, "text")) names.push("verbosity");
  return names;
}

assert.equal(requestBody.model, "anthropic/claude-opus-4.8");
assert.deepEqual(requestBody.provider, { require_parameters: true });
assert.equal(Object.hasOwn(requestBody, "response_format"), true);
assert.equal(Object.hasOwn(requestBody, "max_tokens"), true);
assert.deepEqual(requestBody.reasoning, { effort: "max" });
assert.equal(Object.hasOwn(requestBody, "temperature"), false);

for (const parameter of providerParameterNames(requestBody)) {
  assert.equal(
    supportedParameters.has(parameter),
    true,
    `OpenRouter request includes unsupported provider parameter: ${parameter}`,
  );
}

console.log("OpenRouter request shape verification passed");
