import assert from "node:assert/strict";

import { decodeBinaryVoxelBuild } from "../../../lib/voxel/binaryBuild";
import { createLocalVoxelWorldForTest } from "../../../lib/voxel/localWorld";

async function main() {
  const full = await createLocalVoxelWorldForTest(
    {
      version: "1.0",
      blocks: [],
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 8191, y2: 8191, z2: 8191, type: "stone" }],
    },
    { gridSize: 8192, palette: "simple", worldId: "local-test-full" },
  );

  assert.equal(full.blockCount, 549_755_813_888);
  assert.equal(full.partKeys.length, 0);
  assert.equal(full.build.blocks.length, 0);
  assert.deepEqual(full.build.world?.manifest.regions, [
    {
      kind: "uniform",
      key: "local-test-full.region.0",
      origin: { x: 0, y: 0, z: 0 },
      size: { x: 8192, y: 8192, z: 8192 },
      type: "stone",
      blockCount: 549_755_813_888,
    },
  ]);

  const mixed = await createLocalVoxelWorldForTest(
    {
      version: "1.0",
      blocks: [{ x: 127, y: 127, z: 127, type: "glass" }],
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 127, y2: 127, z2: 127, type: "stone" }],
    },
    { gridSize: 2048, palette: "simple", worldId: "local-test-mixed" },
  );

  const mixedRegion = mixed.build.world?.manifest.regions?.find((region) => region.kind === "mixed");
  assert.equal(mixedRegion?.kind, "mixed");
  if (mixedRegion?.kind !== "mixed") throw new Error("missing mixed region");

  const bytes = mixed.parts.get(mixedRegion.data.key);
  assert.ok(bytes);
  const packed = decodeBinaryVoxelBuild(bytes);
  assert.ok(packed.count > 0);
  for (let index = 0; index < packed.count; index += 1) {
    assert.ok(packed.positions[index * 3] >= 0 && packed.positions[index * 3] < 64);
    assert.ok(packed.positions[index * 3 + 1] >= 0 && packed.positions[index * 3 + 1] < 64);
    assert.ok(packed.positions[index * 3 + 2] >= 0 && packed.positions[index * 3 + 2] < 64);
  }

  console.log("local voxel world checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
