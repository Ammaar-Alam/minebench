import assert from "node:assert/strict";
import { createPackedVoxelBlocks, type PackedVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { createWorldLodPackedBlocks } from "../../../lib/voxel/worldLod";

type PackedEntry = { x: number; y: number; z: number; typeId: number };

function packEntries(entries: PackedEntry[], typeNames = ["stone", "dirt", "glass", "water"]): PackedVoxelBlocks {
  const packed = createPackedVoxelBlocks(entries.length);
  packed.typeNames = typeNames;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    packed.positions[index * 3] = entry.x;
    packed.positions[index * 3 + 1] = entry.y;
    packed.positions[index * 3 + 2] = entry.z;
    packed.typeIds[index] = entry.typeId;
  }
  packed.count = entries.length;
  return packed;
}

function unpackEntries(packed: PackedVoxelBlocks): PackedEntry[] {
  return Array.from({ length: packed.count }, (_, index) => ({
    x: packed.positions[index * 3]!,
    y: packed.positions[index * 3 + 1]!,
    z: packed.positions[index * 3 + 2]!,
    typeId: packed.typeIds[index]!,
  }));
}

function occupiedBuckets(entries: PackedEntry[], scale: number): string[] {
  return Array.from(new Set(entries.map((entry) => [
    Math.floor(entry.x / scale),
    Math.floor(entry.y / scale),
    Math.floor(entry.z / scale),
  ].join(",")))).sort();
}

async function main() {
  {
    const sourceEntries: PackedEntry[] = [
      { x: 37, y: 20, z: 56, typeId: 3 },
      { x: 1, y: 1, z: 1, typeId: 2 },
      { x: 23, y: 15, z: 31, typeId: 2 },
      { x: 8, y: 20, z: 0, typeId: 0 },
      { x: 36, y: 18, z: 56, typeId: 3 },
      { x: 16, y: 8, z: 24, typeId: 2 },
      { x: 2, y: 2, z: 2, typeId: 1 },
      { x: 35, y: 17, z: 56, typeId: 0 },
      { x: 17, y: 9, z: 25, typeId: 1 },
    ];
    const packed = packEntries(sourceEntries);
    const originalPositions = Array.from(packed.positions.slice(0, packed.count * 3));
    const originalTypeIds = Array.from(packed.typeIds.slice(0, packed.count));
    const originalTypeNames = packed.typeNames;

    const lod = createWorldLodPackedBlocks(packed, { x: 38, y: 21, z: 57 }, 8);

    assert.equal(lod.typeNames, originalTypeNames);
    assert.deepEqual(unpackEntries(lod), [
      { x: 0, y: 0, z: 0, typeId: 1 },
      { x: 1, y: 2, z: 0, typeId: 0 },
      { x: 2, y: 1, z: 3, typeId: 2 },
      { x: 4, y: 2, z: 7, typeId: 3 },
    ]);
    assert.deepEqual(occupiedBuckets(unpackEntries(lod), 1), occupiedBuckets(sourceEntries, 8));
    assert.deepEqual(Array.from(packed.positions.slice(0, packed.count * 3)), originalPositions);
    assert.deepEqual(Array.from(packed.typeIds.slice(0, packed.count)), originalTypeIds);
    assert.equal(packed.typeNames, originalTypeNames);
  }

  {
    const packed = packEntries([
      { x: 0, y: 0, z: 0, typeId: 0 },
      { x: 5, y: 6, z: 7, typeId: 1 },
    ]);

    const exact = createWorldLodPackedBlocks(packed, { x: 6, y: 7, z: 8 }, 1);

    assert.equal(exact, packed);
    assert.deepEqual(unpackEntries(exact), unpackEntries(packed));
  }

  {
    const packed = packEntries([{ x: 0, y: 0, z: 0, typeId: 0 }]);
    for (const scale of [0, 3, 64, 1.5, Number.POSITIVE_INFINITY]) {
      assert.throws(() => createWorldLodPackedBlocks(packed, { x: 38, y: 21, z: 57 }, scale), /scale/);
    }
  }

  {
    assert.throws(
      () => createWorldLodPackedBlocks(packEntries([{ x: 38, y: 0, z: 0, typeId: 0 }]), { x: 38, y: 21, z: 57 }, 8),
      /outside region bounds/,
    );
    assert.throws(
      () => createWorldLodPackedBlocks(packEntries([{ x: 0, y: -1, z: 0, typeId: 0 }]), { x: 38, y: 21, z: 57 }, 8),
      /outside region bounds/,
    );
  }

  console.log("world LOD checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
