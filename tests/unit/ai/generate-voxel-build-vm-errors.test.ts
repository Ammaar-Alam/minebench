import assert from "node:assert/strict";

import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";

type OpenRouterRequest = {
  messages?: Array<{ role?: unknown; content?: unknown }>;
};

const originalFetch = globalThis.fetch;
const originalOpenRouterBaseUrl = process.env.OPENROUTER_BASE_URL;
const requests: OpenRouterRequest[] = [];
let retryRecorded = false;

const invalidToolCall = JSON.stringify({
  tool: "voxel.exec",
  input: {
    code: "const R = rng(); R();",
    gridSize: 64,
    palette: "simple",
    seed: 123,
  },
});

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a serialized OpenRouter request body");
  requests.push(JSON.parse(body) as OpenRouterRequest);
  if (requests.length === 2) assert.equal(retryRecorded, true, "retry state should persist before the next request");

  return new Response(
    JSON.stringify({
      choices: [{ message: { content: invalidToolCall } }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}) as typeof fetch;

async function main() {
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  const retries: Array<{ attempt: number; reason: string }> = [];
  const result = await generateVoxelBuild({
    modelKey: "qwen_qwen3_8_max",
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 2,
    enableTools: true,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    onRetry: async (attempt, reason) => {
      await Promise.resolve();
      retries.push({ attempt, reason });
      retryRecorded = true;
    },
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(retries, [{ attempt: 2, reason: "R is not a function" }]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "R is not a function");

  const retryPrompt = requests[1]?.messages?.find((message) => message.role === "user")?.content;
  if (typeof retryPrompt !== "string") throw new Error("Expected a string retry prompt");
  assert.match(retryPrompt, /R is not a function/);

  const originalTimeout = process.env.MINEBENCH_TOOL_TIMEOUT_MS;
  let retained = false;
  let timeoutRequests = 0;
  const timeoutCall = JSON.stringify({ tool: "voxel.exec", input: {
    code: "while (true) {}", gridSize: 8192, palette: "simple", seed: 1,
  } });
  globalThis.fetch = async () => {
    timeoutRequests += 1;
    return Response.json({ choices: [{ message: { content: timeoutCall } }] });
  };
  try {
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = "250";
    const timedOut = await generateVoxelBuild({
      modelKey: "qwen_qwen3_8_max", prompt: "city", gridSize: 8192,
      palette: "simple", maxAttempts: 2, enableTools: true,
      providerKeys: { openrouter: "test-openrouter-key" }, allowServerKeys: false,
      onRawResponse: async (_attempt, text) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(text, timeoutCall);
        retained = true;
      },
    });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) assert.match(timedOut.error, /Script execution timed out after 250ms/);
    assert.equal(timedOut.rawText, timeoutCall);
    assert.equal(retained, true);
    assert.equal(timeoutRequests, 1, "execution timeouts must not buy another generation");
  } finally {
    if (originalTimeout === undefined) delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
    else process.env.MINEBENCH_TOOL_TIMEOUT_MS = originalTimeout;
  }

  console.log("voxel exec VM error propagation checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenRouterBaseUrl === undefined) {
      delete process.env.OPENROUTER_BASE_URL;
    } else {
      process.env.OPENROUTER_BASE_URL = originalOpenRouterBaseUrl;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
