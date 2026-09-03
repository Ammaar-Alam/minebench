import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import {
  customProviderMaxOutputTokens,
  customProviderRequestConfigFromProfile,
  deserializeCustomProviderRequestConfig,
  deserializeSavedGenerationRequestConfig,
  mergeCustomRequestBody,
  normalizeCustomProviderRequestConfig,
  normalizeProviderRequestOverrides,
  parseCustomProviderProfile,
  serializeCustomProviderRequestConfig,
  serializeSavedGenerationRequestConfig,
} from "../../../lib/ai/customProviderConfig";
import { openAiCompatibleGenerateText } from "../../../lib/ai/providers/openaiCompatible";

const profile = parseCustomProviderProfile({
  providerName: "Example Cloud",
  modelId: "example-reasoner",
  baseUrl: "https://models.example.test/v1/chat/completions",
  headers: [{ name: "User-Agent", value: "claude-cli/2.1.179 (external, cli)" }],
  body: [
    { name: "thinking", value: '{"type":"enabled"}' },
    { name: "reasoning_effort", value: "max" },
    { name: "max_tokens", value: "128000" },
  ],
});
const config = customProviderRequestConfigFromProfile(profile);
assert.deepEqual(config, {
  baseUrl: "https://models.example.test/v1/chat/completions",
  headers: { "User-Agent": "claude-cli/2.1.179 (external, cli)" },
  body: {
    thinking: { type: "enabled" },
    reasoning_effort: "max",
    max_tokens: 128_000,
  },
});
assert.equal(customProviderMaxOutputTokens(config.body), 128_000);
assert.deepEqual(
  deserializeCustomProviderRequestConfig(serializeCustomProviderRequestConfig(config)),
  config,
);
const catalogOverrides = normalizeProviderRequestOverrides({
  headers: { "X-Request-Mode": "benchmark" },
  body: {
    max_output_tokens: 32_768,
    reasoning: { effort: "low" },
    text: { verbosity: "low", format: { type: "unsafe" } },
  },
});
assert.equal(customProviderMaxOutputTokens(catalogOverrides.body), 32_768);
assert.deepEqual(
  deserializeSavedGenerationRequestConfig(
    serializeSavedGenerationRequestConfig(catalogOverrides),
  ),
  catalogOverrides,
);
assert.deepEqual(
  mergeCustomRequestBody(
    { text: { format: { type: "json_schema" }, verbosity: "medium" } },
    catalogOverrides.body,
    ["text.format"],
  ),
  {
    max_output_tokens: 32_768,
    reasoning: { effort: "low" },
    text: { format: { type: "json_schema" }, verbosity: "low" },
  },
);
assert.deepEqual(
  deserializeCustomProviderRequestConfig("https://legacy.example.test/v1/chat/completions"),
  { baseUrl: "https://legacy.example.test/v1/chat/completions" },
);

assert.throws(
  () => normalizeCustomProviderRequestConfig({
    baseUrl: profile.baseUrl,
    headers: { Host: "private.example.test" },
  }),
  /Host is managed by MineBench/,
);
assert.throws(
  () => customProviderRequestConfigFromProfile({
    ...profile,
    body: [{ name: "messages", value: "[]" }],
  }),
  /messages is managed by MineBench/,
);
assert.throws(
  () => normalizeProviderRequestOverrides({ body: { input: "replacement" } }),
  /input is managed by MineBench/,
);
assert.throws(
  () => normalizeProviderRequestOverrides({ body: { reasoning: { constructor: {} } } }),
  /constructor cannot be customized/,
);
assert.throws(
  () => customProviderRequestConfigFromProfile({
    ...profile,
    headers: [
      { name: "User-Agent", value: "one" },
      { name: "user-agent", value: "two" },
    ],
  }),
  /Header names must be unique/,
);

const originalLookup = dns.lookup;
const originalHttpsRequest = https.request;
const requests: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
const server = http.createServer(async (request, response) => {
  let rawBody = "";
  for await (const chunk of request) rawBody += chunk.toString();
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  requests.push({ headers: request.headers, body });
  response.setHeader("Content-Type", "application/json");
  if (Object.hasOwn(body, "response_format")) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
    return;
  }
  response.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
});

Object.defineProperty(dns, "lookup", {
  configurable: true,
  value: async () => [{ address: "93.184.216.34", family: 4 }],
});
Object.defineProperty(https, "request", {
  configurable: true,
  value: ((
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => http.request({ ...options, hostname: "127.0.0.1", family: 4 }, callback)) as typeof https.request,
});

async function main() {
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await openAiCompatibleGenerateText({
      modelId: profile.modelId,
      apiKey: "test-key",
      baseUrl: `https://models.example.test:${address.port}/v1/chat/completions`,
      customHeaders: config.headers,
      customBody: config.body,
      system: "system",
      user: "user",
      jsonSchema: { type: "object" },
    });

    assert.equal(result.text, "done");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers["user-agent"], "claude-cli/2.1.179 (external, cli)");
    assert.equal(requests[0].headers.authorization, "Bearer test-key");
    assert.deepEqual(requests[1].body.thinking, { type: "enabled" });
    assert.equal(requests[1].body.reasoning_effort, "max");
    assert.equal(requests[1].body.max_tokens, 128_000);
    assert.equal(requests[1].body.model, profile.modelId);
    assert.equal(Object.hasOwn(requests[1].body, "response_format"), false);
  } finally {
    Object.defineProperty(dns, "lookup", { configurable: true, value: originalLookup });
    Object.defineProperty(https, "request", { configurable: true, value: originalHttpsRequest });
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  console.log("custom provider config checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
