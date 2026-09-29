import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { selectGenerationProviderKeys } from "../../../lib/ai/providerKeys";

const require = createRequire(import.meta.url);
const queued: Array<{ prompt: string; gridSize: number; providerKeys: Record<string, string> }> = [];
for (const [path, exports] of [
  ["../../../lib/auth/request", { getAuthenticatedUserId: async () => "00000000-0000-4000-8000-000000000001" }],
  ["../../../lib/generations/service", { createSavedGenerations: async (input: typeof queued[number]) => { queued.push(input); return []; } }],
] as const) {
  const id = require.resolve(path);
  const stub = new Module(id);
  stub.exports = exports;
  stub.loaded = true;
  require.cache[id] = stub;
}
const { POST } = require("../../../app/api/generations/route") as { POST: (request: Request) => Promise<Response> };
const models = [{ id: "openai_gpt_6_astra", kind: "catalog", modelKey: "openai_gpt_6_astra" }] as const;
const providerKeys = selectGenerationProviderKeys([...models], {
  openai: "test-openai-key", openrouter: "test-openrouter-key",
});

function request(prompt: string, gridSize = 8192) {
  return new Request("https://alpha.minebench.ai/api/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, gridSize, palette: "advanced", models, providerKeys }),
  });
}

async function main() {
  for (const length of [80, 800]) {
    assert.equal((await POST(request(`  ${"a".repeat(length)}  `))).status, 202);
    assert.equal(queued.at(-1)?.prompt.length, length);
    assert.equal(queued.at(-1)?.gridSize, 8192);
    assert.deepEqual(queued.at(-1)?.providerKeys, { openai: "test-openai-key" });
  }
  for (const length of [801, 915]) {
    const response = await POST(request("a".repeat(length)));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual((await response.json()).error, {
      code: "invalid_request", message: "Keep the prompt to 800 characters or fewer.",
    });
  }
  assert.equal((await POST(request("A city", 8000))).status, 400);
  assert.equal(queued.length, 2, "invalid requests must not create jobs");
  console.log("saved generation request validation checks passed");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
