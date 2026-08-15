import assert from "node:assert/strict";
import {
  appendPackedVoxelBlocks,
  copyPackedVoxelBlocks,
  createPackedVoxelBlocks,
  packVoxelBlocks,
  packedVoxelBlocksCapacity,
  reservePackedVoxelBlocks,
  toObjectBackedVoxelBuild,
  unpackVoxelBlocks,
  voxelBuildBlockCount,
  voxelBuildBlocksRef,
} from "../../../lib/voxel/packedBlocks";
import type { VoxelBlock } from "../../../lib/voxel/types";

function makeBlocks(count: number, offset = 0): VoxelBlock[] {
  const types = ["stone", "water", "oak_leaves"];
  return Array.from({ length: count }, (_, i) => ({
    x: (offset + i) % 256,
    y: Math.floor((offset + i) / 256) % 256,
    z: (offset + i) % 97,
    type: types[(offset + i) % types.length],
  }));
}

function assertRoundTrip(packed: ReturnType<typeof packVoxelBlocks>, expected: VoxelBlock[]) {
  assert.equal(packed.count, expected.length);
  assert.deepEqual(unpackVoxelBlocks(packed), expected);
}

async function main() {
  {
    const blocks = makeBlocks(500);
    assertRoundTrip(packVoxelBlocks(blocks), blocks);
  }

  {
    // chunked arrival: the palette and block order have to survive the seams
    const chunks = [makeBlocks(300, 0), makeBlocks(300, 300), makeBlocks(120, 600)];
    const packed = createPackedVoxelBlocks(720);
    for (const chunk of chunks) appendPackedVoxelBlocks(packed, chunk);
    assertRoundTrip(packed, chunks.flat());
    assert.deepEqual(packed.typeNames, ["stone", "water", "oak_leaves"]);
  }

  {
    // an announced total is a plan, not a guarantee: overflow has to grow
    const announced = 1024;
    const packed = createPackedVoxelBlocks(announced);
    reservePackedVoxelBlocks(packed, announced);
    assert.equal(packedVoxelBlocksCapacity(packed), announced);
    const blocks = makeBlocks(announced + 777);
    appendPackedVoxelBlocks(packed, blocks.slice(0, announced));
    appendPackedVoxelBlocks(packed, blocks.slice(announced));
    assert.ok(packedVoxelBlocksCapacity(packed) >= blocks.length);
    assertRoundTrip(packed, blocks);
  }

  {
    // a late reserve must not drop what already arrived
    const packed = createPackedVoxelBlocks(0);
    const first = makeBlocks(64);
    appendPackedVoxelBlocks(packed, first);
    reservePackedVoxelBlocks(packed, 50_000);
    assert.ok(packedVoxelBlocksCapacity(packed) >= 50_000);
    assertRoundTrip(packed, first);
  }

  {
    // the worker copy is trimmed to the filled prefix and owns its buffers, so
    // transferring it cannot detach arrays a lane is still hydrating into
    const packed = createPackedVoxelBlocks(4096);
    const blocks = makeBlocks(1000);
    appendPackedVoxelBlocks(packed, blocks);
    const copy = copyPackedVoxelBlocks(packed);
    assert.equal(copy.count, blocks.length);
    assert.equal(copy.typeIds.length, blocks.length);
    assert.equal(copy.positions.length, blocks.length * 3);
    assert.notEqual(copy.positions.buffer, packed.positions.buffer);
    assert.notEqual(copy.typeNames, packed.typeNames);
    assertRoundTrip(copy, blocks);

    const limited = copyPackedVoxelBlocks(packed, 250);
    assert.equal(limited.count, 250);
    assertRoundTrip(limited, blocks.slice(0, 250));

    // a limit past the filled prefix cannot invent blocks
    assert.equal(copyPackedVoxelBlocks(packed, 5000).count, blocks.length);
  }

  {
    const blocks = makeBlocks(10);
    const objectBuild = { version: "1.0" as const, blocks };
    const packedBuild = { version: "1.0" as const, blocks: [], packed: packVoxelBlocks(blocks) };

    assert.equal(voxelBuildBlockCount(objectBuild), 10);
    assert.equal(voxelBuildBlockCount(packedBuild), 10);
    assert.equal(voxelBuildBlockCount(null), 0);

    assert.equal(voxelBuildBlocksRef(objectBuild), objectBuild.blocks);
    assert.equal(voxelBuildBlocksRef(packedBuild), packedBuild.packed);

    const materialized = toObjectBackedVoxelBuild(packedBuild);
    assert.deepEqual(materialized.blocks, blocks);
    assert.equal("packed" in materialized, false);
    assert.equal(toObjectBackedVoxelBuild(objectBuild), objectBuild);
  }

  {
    // negative coordinates and the grid edges have to survive Int16 storage
    const blocks: VoxelBlock[] = [
      { x: -256, y: 0, z: 255, type: "stone" },
      { x: 511, y: 255, z: -1, type: "water" },
    ];
    assertRoundTrip(packVoxelBlocks(blocks), blocks);
  }

  console.log("packed voxel block checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
