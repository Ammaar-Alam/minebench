import assert from "node:assert/strict";

import {
  installFetchCapture,
  jsonResponse,
  withProviderTestEnv,
  type CapturedRequest,
} from "../../helpers/providerConfigHarness";

// A build with enough blocks to clear the minBlocks floor (200 for gridSize 64)
// without relying on boxes/lines expansion. 200 distinct in-bounds stone cells
// spanning at least 9 on x and 6 on y to satisfy the footprint/height spans.
function bigBuildJson(): string {
  const blocks: Array<{ x: number; y: number; z: number; type: string }> = [];
  for (let i = 0; i < 200; i += 1) {
    blocks.push({ x: i % 10, y: Math.floor(i / 10) % 20, z: Math.floor(i / 200), type: "stone" });
  }
  return JSON.stringify({ version: "1.0", boxes: [], lines: [], blocks });
}

// A plain-text (no response_format) OpenRouter chat-completions response whose
// content begins with prose containing a single unbalanced double-quote, then
// a valid VoxelBuild JSON object -- the exact shape that desyncs the pre-fix
// scanner and yields "Could not find a valid JSON object in the response".
function strayQuotePreambleResponse(): Response {
  const content = `Here is the " voxel build as JSON:\n` + bigBuildJson();
  return jsonResponse({
    choices: [{ message: { content } }],
  });
}

function pureBuildResponse(): Response {
  return jsonResponse({
    choices: [{ message: { content: bigBuildJson() } }],
  });
}

const model = {
  key: "openrouter-plain-text",
  provider: "custom" as const,
  modelId: "stealth/ox-alpha",
  displayName: "stealth/ox-alpha",
  openRouterModelId: "stealth/ox-alpha",
  forceOpenRouter: true,
  requireStructuredOutput: false,
};

async function runGenerationWith(responder: (req: CapturedRequest) => Response) {
  const capture = installFetchCapture();
  capture.respondWith((req) => responder(req));
  const { generateVoxelBuild } = await import("../../../lib/ai/generateVoxelBuild");
  let result: Awaited<ReturnType<typeof generateVoxelBuild>>;
  await withProviderTestEnv(
    {
      OPENROUTER_BASE_URL: "https://openrouter.test/api",
      // Make sure we exercise the notools path (extractBestVoxelBuildJson).
      MINEBENCH_MAX_OUTPUT_TOKENS: "999999",
    },
    async () => {
      result = await generateVoxelBuild({
        model,
        prompt: "small tower",
        gridSize: 64,
        palette: "simple",
        maxAttempts: 1,
        enableTools: false,
        providerKeys: { openrouter: "test-openrouter-key" },
        allowServerKeys: false,
      });
    },
  );
  const requests = capture.requests;
  capture.restore();
  return { requests, result: result! };
}

async function main() {
  // --- G14: stray-quote plain-text preamble parses on the FIRST attempt ---
  {
    const { requests, result } = await runGenerationWith(() => strayQuotePreambleResponse());
    assert.equal(
      requests.length,
      1,
      `stray-quote preamble should succeed in 1 request; got ${requests.length} (a repair retry would mean extraction failed)`,
    );
    assert.equal(result.ok, true, `stray-quote preamble should parse; error: ${result.ok ? "" : result.error}`);
    assert.equal(result.providerRoute, "openrouter");
    if (result.ok) {
      assert.ok(
        result.build.blocks.length >= 1,
        "stray-quote preamble build should have at least 1 block",
      );
    }
  }

  // --- G14 breadth: stray quote as a wrapping quote ("Output "JSON": " ... ") ---
  {
    const { requests, result } = await runGenerationWith(() => {
      const content = `Output "JSON": " ` + bigBuildJson() + ` "`;
      return jsonResponse({ choices: [{ message: { content } }] });
    });
    assert.equal(requests.length, 1, "wrapped-quote preamble should succeed in 1 request");
    assert.equal(result.ok, true, `wrapped-quote preamble should parse; error: ${result.ok ? "" : result.error}`);
  }

  // --- G15 control: pure JSON (no preamble) succeeds on first attempt ---
  {
    const { requests, result } = await runGenerationWith(() => pureBuildResponse());
    assert.equal(requests.length, 1, "pure JSON control should succeed in 1 request");
    assert.equal(
      result.ok,
      true,
      `pure JSON control should parse; error: ${result.ok ? "" : result.error}`,
    );
  }

  // --- Regression control: balanced quotes in prose still succeed ---
  {
    const { requests, result } = await runGenerationWith(() => {
      const content = `Sure, here is "the" build as "JSON":\n` + bigBuildJson();
      return jsonResponse({ choices: [{ message: { content } }] });
    });
    assert.equal(requests.length, 1, "balanced-quote preamble should succeed in 1 request");
    assert.equal(result.ok, true, `balanced-quote preamble should parse; error: ${result.ok ? "" : result.error}`);
  }

  console.log("generation fetch-stub end-to-end checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
