import assert from "node:assert/strict";
import {
  createExplorerBlockLightGrid,
  getExplorerBlockLight,
  isExplorerSunRayVisible,
  renderExplorerBloomOverlay,
} from "@/lib/voxel/explorerLighting";
import {
  packVoxelBlocks,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";

const openBuild: RenderableVoxelBuild = {
  version: "1.0",
  blocks: [
    { x: 0, y: 0, z: 0, type: "glowstone" },
    { x: 20, y: 0, z: 0, type: "glowstone" },
    { x: 1, y: 0, z: 0, type: "glass" },
  ],
};

async function main() {
  const open = await createExplorerBlockLightGrid(openBuild);
  assert.ok(open);
  assert.equal(getExplorerBlockLight(open, 0, 0, 0), 15);
  assert.equal(getExplorerBlockLight(open, 1, 0, 0), 14);
  assert.equal(getExplorerBlockLight(open, 2, 0, 0), 13);
  assert.equal(getExplorerBlockLight(open, 20, 0, 0), 15);

  const enclosure = await createExplorerBlockLightGrid({
    version: "1.0",
    blocks: [
      { x: 0, y: 0, z: 0, type: "glowstone" },
      { x: -1, y: 0, z: 0, type: "stone" },
      { x: 1, y: 0, z: 0, type: "stone" },
      { x: 0, y: -1, z: 0, type: "stone" },
      { x: 0, y: 1, z: 0, type: "stone" },
      { x: 0, y: 0, z: -1, type: "stone" },
      { x: 0, y: 0, z: 1, type: "stone" },
    ],
  });
  assert.ok(enclosure);
  assert.equal(getExplorerBlockLight(enclosure, 2, 0, 0), 0);

  const packed = await createExplorerBlockLightGrid({
    version: "1.0",
    blocks: [],
    packed: packVoxelBlocks(openBuild.blocks),
  });
  assert.ok(packed);
  assert.equal(getExplorerBlockLight(packed, 2, 0, 0), 13);

  assert.equal(
    await createExplorerBlockLightGrid({
      version: "1.0",
      blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
    }),
    null,
  );
  assert.equal(isExplorerSunRayVisible(0, 0, 0), true);
  assert.equal(isExplorerSunRayVisible(1.3, 0, 0), false);
  assert.equal(isExplorerSunRayVisible(0, 0, 2), false);

  const renderer = { autoClear: true };
  renderExplorerBloomOverlay(renderer, () => assert.equal(renderer.autoClear, false));
  assert.equal(renderer.autoClear, true);
  assert.throws(() => renderExplorerBloomOverlay(renderer, () => { throw new Error("draw failed"); }));
  assert.equal(renderer.autoClear, true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
