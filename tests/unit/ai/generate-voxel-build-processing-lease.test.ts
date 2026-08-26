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
    returnExpandedBuild: true,
    acquireBuildProcessing: async () => {
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
