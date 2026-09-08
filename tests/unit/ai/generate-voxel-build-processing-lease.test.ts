import assert from "node:assert/strict";

import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";

const originalFetch = globalThis.fetch;
const originalOpenRouterBaseUrl = process.env.OPENROUTER_BASE_URL;
let requestCount = 0;

const invalidToolCall = JSON.stringify({
  tool: "voxel.exec",
  input: {
    code: "throw new Error('retry me')",
    gridSize: 64,
    palette: "simple",
    seed: 1,
  },
});

const validToolCall = JSON.stringify({
  tool: "voxel.exec",
  input: {
    code: "box(1, 1, 1, 12, 10, 12, 'stone')",
    gridSize: 64,
    palette: "simple",
    seed: 2,
  },
});

globalThis.fetch = (async (): Promise<Response> => {
  requestCount += 1;
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: requestCount === 1 ? invalidToolCall : validToolCall } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

async function main() {
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";

  let acquired = 0;
  let released = 0;
  let persistedResponse = false;
  let releaseSuccessfulBuild: (() => void) | undefined;
  const result = await generateVoxelBuild({
    modelKey: "qwen_qwen3_8_max",
    prompt: "stone tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 2,
    enableTools: true,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    buildOutput: "objects",
    onRawResponse: async () => {
      persistedResponse = false;
      await Promise.resolve();
      persistedResponse = true;
    },
    acquireBuildProcessing: async () => {
      assert.equal(persistedResponse, true, "response persistence must finish before execution");
      acquired += 1;
      let didRelease = false;
      const release = () => {
        if (didRelease) return;
        didRelease = true;
        released += 1;
      };
      releaseSuccessfulBuild = release;
      return release;
    },
  });

  if (!result.ok) throw new Error(result.error);
  assert.equal(result.ok, true);
  assert.equal(requestCount, 2);
  assert.equal(acquired, 2, "each response should acquire the bounded local-processing lane");
  assert.equal(released, 1, "a failed attempt should release its processing lane before retrying");
  assert.equal(result.build.blocks.length, 1_440);
  assert.equal(result.build.boxes, undefined, "the durable worker should reuse the expanded build");
  assert.equal(result.build.lines, undefined);

  releaseSuccessfulBuild?.();
  assert.equal(released, 2, "the caller should release a successful build after artifact packaging");

  const requestsBeforeFailure = requestCount;
  const heapFailure = await generateVoxelBuild({
    modelKey: "qwen_qwen3_8_max",
    prompt: "stone tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 2,
    providerKeys: { openrouter: "test-openrouter-key" },
    allowServerKeys: false,
    buildOutput: "packed",
    processResponse: async () => { throw new Error("heap_limit_exceeded"); },
    acquireBuildProcessing: async () => () => { released += 1; },
  });
  assert.equal(heapFailure.ok, false);
  if (heapFailure.ok) throw new Error("expected a contained heap failure");
  assert.equal(heapFailure.error, "heap_limit_exceeded");
  assert.equal(requestCount, requestsBeforeFailure + 1, "heap failure must not buy another response");
  assert.equal(released, 3, "isolated failure must release the finalization gate");
  assert.equal(heapFailure.rawText, validToolCall);

  console.log("voxel build processing lease checks passed");
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
