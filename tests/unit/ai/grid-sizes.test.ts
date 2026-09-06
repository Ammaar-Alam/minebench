import assert from "node:assert/strict";
import { POST } from "../../../app/api/local/voxel-exec/route";
import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";
import { GRID_SIZES, isGridSize } from "../../../lib/ai/limits";
import { voxelExecToolCallJsonSchema, voxelExecToolCallSchema } from "../../../lib/ai/tools/voxelExec";
import { validateGeneratedBuildForArtifacts } from "../../../lib/custom-builds/generateJob";

async function main() {
  assert.deepEqual(GRID_SIZES, [32, 64, 256, 512, 2048, 8192]);
  assert.deepEqual(voxelExecToolCallJsonSchema().properties.input.properties.gridSize.enum, GRID_SIZES);
  for (const invalid of [0, -1, 16, 1024, 4096, 8193, 8192.5, "8192", null]) {
    assert.equal(isGridSize(invalid), false);
  }

  const originalFetch = globalThis.fetch;
  try {
    for (const gridSize of [32, 2048, 8192] as const) {
      const edge = gridSize - 1;
      const width = gridSize === 8192 ? gridSize : gridSize === 32 ? 10 : 76;
      const height = gridSize === 8192 ? gridSize : gridSize === 32 ? 10 : 51;
      const depth = gridSize === 8192 ? gridSize : 1;
      const call = {
        tool: "voxel.exec",
        input: {
          code: `box(${gridSize - width},0,${gridSize - depth},${edge},${height - 1},${edge},"gray_concrete")`,
          gridSize,
          palette: "advanced",
          seed: 1,
        },
      };
      assert.equal(voxelExecToolCallSchema.safeParse(call).success, true);
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(call) } }],
      }), { headers: { "Content-Type": "application/json" } });

      const generated = await generateVoxelBuild({
        modelKey: "qwen_qwen3_8_max",
        prompt: "A concrete wall",
        gridSize,
        palette: "advanced",
        maxAttempts: 1,
        providerKeys: { openrouter: "test-openrouter-key" },
        allowServerKeys: false,
        returnExpandedBuild: true,
      });
      if (!generated.ok) throw new Error(generated.error);
      assert.equal(generated.blockCount, width * height * depth);
      if (gridSize > 512) {
        assert.equal(generated.build.blocks.length, 0);
        assert.equal(generated.build.boxes?.[0]?.x2, edge);
        assert.equal(generated.build.boxes?.[0]?.z2, edge);
      } else {
        assert.ok(generated.build.blocks.some((block) => block.x === edge && block.z === edge));
      }
      const saved = validateGeneratedBuildForArtifacts(generated.build, { gridSize, palette: "advanced" });
      assert.deepEqual(saved.build, generated.build);

      const response = await POST(new Request("http://localhost:3000/api/local/voxel-exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(call.input),
      }));
      assert.equal(response.status, 200);
      const imported = await response.json();
      assert.deepEqual(imported.build, generated.build);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("grid size generation and import checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
