import assert from "node:assert/strict";
import { encodeTransferableVoxelBlocks } from "../../../lib/voxel/mesh";

async function main() {
  const blocks = [
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 511, y: 255, z: 511, type: "oak_leaves" },
    { x: 3, y: 7, z: 9, type: "stone" },
    { x: 1, y: 2, z: 3, type: "water" },
  ];

  const encoded = encodeTransferableVoxelBlocks(blocks);
  assert.equal(encoded.typeIds.length, blocks.length);
  assert.equal(encoded.positions.length, blocks.length * 3);
  assert.deepEqual(encoded.typeNames, ["stone", "oak_leaves", "water"]);

  for (let i = 0; i < blocks.length; i += 1) {
    assert.equal(encoded.positions[i * 3], blocks[i].x, `x roundtrip at ${i}`);
    assert.equal(encoded.positions[i * 3 + 1], blocks[i].y, `y roundtrip at ${i}`);
    assert.equal(encoded.positions[i * 3 + 2], blocks[i].z, `z roundtrip at ${i}`);
    assert.equal(encoded.typeNames[encoded.typeIds[i]], blocks[i].type, `type roundtrip at ${i}`);
  }

  console.log("transferable voxel block encoding checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
