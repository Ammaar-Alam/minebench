import assert from "node:assert/strict";
import {
  appendCoalescedVoxelBox,
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
import type { VoxelBlock, VoxelBox } from "../../../lib/voxel/types";
import { parseVoxelBuildSpec } from "../../../lib/voxel/validate";

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
    const boxes: VoxelBox[] = [];
    for (const x of [0, 1, 2]) appendCoalescedVoxelBox(boxes, { x1: x, y1: 0, z1: 0, x2: x, y2: 1, z2: 1, type: "stone" });
    assert.deepEqual(boxes, [{ x1: 0, y1: 0, z1: 0, x2: 2, y2: 1, z2: 1, type: "stone" }]);
    appendCoalescedVoxelBox(boxes, { x1: 2, y1: 0, z1: 0, x2: 3, y2: 1, z2: 1, type: "stone" });
    assert.equal(boxes.length, 2);
    const reversed: VoxelBox[] = [{ x1: 3, y1: 0, z1: 0, x2: 1, y2: 0, z2: 0, type: "stone" }];
    appendCoalescedVoxelBox(reversed, { x1: 2, y1: 0, z1: 0, x2: 2, y2: 0, z2: 0, type: "stone" });
    assert.equal(reversed.length, 2);

    const packed = packVoxelBlocks([{ x: 8191, y: 2, z: 3, type: "stone" }]);
    const source = { version: "1.0", blocks: [], boxes, packed };
    const parsed = parseVoxelBuildSpec(source);
    assert.ok(parsed.ok);
    if (parsed.ok) assert.equal(parsed.value, source);
    assert.equal(parseVoxelBuildSpec({ ...source, packed: { ...packed, count: 2 } }).ok, false);
    assert.equal(parseVoxelBuildSpec({ ...source, packed: { ...packed, typeNames: [] } }).ok, false);
    assert.throws(() => packVoxelBlocks([{ x: 32768, y: 0, z: 0, type: "stone" }]), /coordinate range/);
  }
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
      { x: 8191, y: 255, z: -1, type: "water" },
    ];
    assertRoundTrip(packVoxelBlocks(blocks), blocks);
  }

  {
    const bounds = { origin: { x: 0, y: 0, z: 0 }, size: { x: 8192, y: 8192, z: 8192 } };
    const build = {
      version: "1.0" as const,
      blocks: [],
      world: {
        manifest: {
          kind: "voxel_world" as const, version: 1 as const, gridSize: 8192,
          palette: "simple" as const, bounds, exactBlockCount: 8192 ** 3, leafSize: 64 as const,
          source: { format: "voxel-build-json" as const, sha256: "0".repeat(64), evaluatorVersion: 1 },
          regions: [{ kind: "uniform" as const, key: "r0", ...bounds, type: "stone", blockCount: 8192 ** 3 }],
        },
      },
    };
    assert.equal(voxelBuildBlockCount(build), 549_755_813_888);
    assert.equal(voxelBuildBlocksRef(build), build.world);
    assert.throws(() => toObjectBackedVoxelBuild(build), /Download its JSON/);
  }

  console.log("packed voxel block checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
