import assert from "node:assert/strict";
import { POST } from "../../../app/api/generate/route";
import type { GenerateEvent } from "../../../lib/ai/types";
import { createLocalVoxelWorldForTest } from "../../../lib/voxel/localWorld";

async function main() {
  const originalFetch = globalThis.fetch;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  try {
    for (const gridSize of [256, 2048, 8192]) {
      const call = {
        tool: "voxel.exec",
        input: {
          gridSize, palette: "simple", seed: 1,
          code: 'for(let i=0;i<12000;i++) block(i%120,Math.floor(i/120),0,"stone"); box(0,0,4,3,3,7,"glass");',
        },
      };
      globalThis.fetch = async () => new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(call) } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
      const response = await POST(new Request("http://localhost:3000/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "A stone plaza with a glass sculpture", gridSize, palette: "simple",
          modelKeys: ["qwen_qwen3_8_max"], providerKeys: { openrouter: "test-openrouter-key" },
        }),
      }));
      assert.equal(response.status, 200);
      const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)) as GenerateEvent[];
      assert.deepEqual(events.filter((event) => event.type === "error"), []);
      const result = events.find((event) => event.type === "result");
      assert.ok(result);
      assert.equal(result.modelKey, "qwen_qwen3_8_max");
      assert.equal(result.metrics.blockCount, 12_064);
      if (gridSize <= 512) {
        assert.equal(result.voxelBuild.blocks.length, 12_000);
        assert.equal(result.voxelBuild.boxes?.length, 1);
        continue;
      }
      const world = await createLocalVoxelWorldForTest(result.voxelBuild, { gridSize, palette: "simple" });
      assert.equal(world.blockCount, result.metrics.blockCount);
      assert.equal(result.voxelBuild.blocks.length, 12_000);
      assert.equal(result.voxelBuild.boxes?.length, 1);
      assert.equal(result.voxelBuild.packed, undefined);
      assert.equal(result.voxelBuild.packedBoxes, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }
  console.log("anonymous world generation serialization checks passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
