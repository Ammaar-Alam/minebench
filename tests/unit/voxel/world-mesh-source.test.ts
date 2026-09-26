import assert from "node:assert/strict";
import { createPackedVoxelBlocks, unpackVoxelBlocks, type PackedVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { createWorldMeshBatches, packWorldMeshBatch } from "../../../lib/voxel/worldMeshSource";
import type { VoxelWorldMixedRegion, VoxelWorldRegion } from "../../../lib/voxel/world";

function mixed(key: string, origin: [number, number, number], size: [number, number, number], blockCount = 1): VoxelWorldMixedRegion {
  return {
    key, kind: "mixed", origin: { x: origin[0], y: origin[1], z: origin[2] },
    size: { x: size[0], y: size[1], z: size[2] }, blockCount,
    format: "mbv4", coordinateSpace: "local",
    data: { kind: "localBlob", key, encoding: "identity", byteSize: 1 },
  };
}

function pack(entries: Array<[number, number, number, number]>, typeNames = ["stone", "glass"]): PackedVoxelBlocks {
  const packed = createPackedVoxelBlocks(entries.length + 1);
  packed.typeNames = typeNames;
  packed.count = entries.length;
  for (const [index, [x, y, z, typeId]] of entries.entries()) {
    packed.positions.set([x, y, z], index * 3);
    packed.typeIds[index] = typeId;
  }
  packed.positions.set([32767, 32767, 32767], entries.length * 3);
  packed.typeIds[entries.length] = 65535;
  return packed;
}

function positions(packed: PackedVoxelBlocks): string[] {
  return unpackVoxelBlocks(packed).map(({ x, y, z, type }) => `${x},${y},${z}:${type}`).sort();
}

function main() {
  assert.deepEqual(createWorldMeshBatches([]), []);
  {
    const lower = mixed("lower", [500, 100, 100], [40, 4, 4], 2);
    const upper = mixed("upper", [500, 108, 100], [40, 4, 4]);
    const inside = mixed("inside", [512, 104, 100], [28, 4, 4], 3);
    const right = mixed("right", [540, 100, 100], [8, 4, 4], 2);
    const far = mixed("far", [2048, 100, 100], [4, 4, 4]);
    const regions = [lower, upper, inside, right, far];
    const originalRegions = structuredClone(regions);
    const parts = new Map([
      [lower.key, pack([[39, 1, 1, 0], [12, 3, 1, 1]])],
      [upper.key, pack([[12, 0, 1, 0]], ["glass", "stone"])],
      [inside.key, pack([[0, 0, 1, 0], [1, 2, 1, 1], [27, 3, 3, 1]], ["glass", "stone"])],
      [right.key, pack([[0, 1, 1, 1], [1, 1, 1, 0]])],
    ]);
    const originals = structuredClone(parts);
    const batches = createWorldMeshBatches(regions);
    assert.deepEqual(createWorldMeshBatches(regions, false), batches.map((batch) => ({ ...batch, neighbors: [] })));
    assert.equal(batches.length, 3);
    const batch = batches.find((candidate) => candidate.regions.includes(lower))!;
    assert.deepEqual(batch.bounds, { origin: { x: 500, y: 100, z: 100 }, size: { x: 40, y: 12, z: 4 } });
    assert.deepEqual(batch.regions, [lower, upper]);
    assert.deepEqual(batch.neighbors, [inside, right]);

    const { packed, halo } = packWorldMeshBatch(batch, parts);
    assert.equal(packed.typeIds.length, packed.count, "owned cells reserve their exact validated count");
    assert.equal(packed.positions.length, packed.count * 3);
    assert.deepEqual(positions(packed), ["12,3,1:glass", "12,8,1:glass", "39,1,1:stone"]);
    assert.deepEqual(positions(halo), ["12,4,1:glass", "13,6,1:stone", "39,7,3:stone", "40,1,1:glass"]);
    assert.equal(packed.typeNames, halo.typeNames);
    assert.deepEqual(packed.typeNames, ["stone", "glass"]);
    assert.deepEqual(parts, originals);
    assert.deepEqual(regions, originalRegions);
    for (const part of parts.values()) assert.notEqual(packed.typeNames, part.typeNames);
  }

  {
    const lower = mixed("lower", [1000, 2050, 3000], [64, 64, 64]);
    const upper = mixed("upper", [1000, 2114, 3000], [64, 64, 64]);
    const uniform: VoxelWorldRegion = {
      kind: "uniform", key: "large-wall", type: "dirt", origin: { x: 1064, y: 0, z: 0 },
      size: { x: 8192 - 1064, y: 8192, z: 8192 }, blockCount: (8192 - 1064) * 8192 * 8192,
    };
    const [batch] = createWorldMeshBatches([lower, upper, uniform]);
    const parts = new Map([[lower.key, pack([[63, 63, 63, 0]])], [upper.key, pack([[63, 0, 63, 0]])]]);
    const originals = structuredClone(parts);
    const { packed, halo } = packWorldMeshBatch(batch, parts);
    assert.equal(packed.count, 2);
    assert.equal(halo.count, 130 * 66);
    assert.equal(new Set(positions(halo)).size, halo.count);
    for (const block of unpackVoxelBlocks(halo)) {
      assert.equal(block.x, 64);
      assert.ok(block.y >= -1 && block.y <= 128);
      assert.ok(block.z >= -1 && block.z <= 64);
      assert.equal(block.type, "dirt");
    }
    assert.equal(packed.typeNames, halo.typeNames);
    assert.deepEqual(parts, originals);
    assert.deepEqual(createWorldMeshBatches([uniform]), []);
  }

  {
    const left = mixed("left", [0, 100, 100], [2, 2, 2]);
    const right = mixed("right", [400, 100, 100], [2, 2, 2]);
    const uniform: VoxelWorldRegion = {
      kind: "uniform", key: "large-interior", type: "dirt", origin: { x: 2, y: 0, z: 0 },
      size: { x: 398, y: 8192, z: 8192 }, blockCount: 398 * 8192 * 8192,
    };
    const [batch] = createWorldMeshBatches([left, right, uniform]);
    const { halo } = packWorldMeshBatch(batch, new Map([[left.key, pack([[1, 0, 0, 0]])], [right.key, pack([[0, 0, 0, 0]])]]));
    assert.equal(halo.count, 32);
    assert.ok(unpackVoxelBlocks(halo).every((block) => block.x === 2 || block.x === 399));
  }

  {
    const region = mixed("invalid", [0, 0, 0], [2, 2, 2]);
    const [batch] = createWorldMeshBatches([region]);
    const attempt = (part: PackedVoxelBlocks) => packWorldMeshBatch(batch, new Map([[region.key, part]]));
    assert.throws(() => packWorldMeshBatch(batch, new Map()), /data is missing/);
    assert.throws(() => attempt(pack([])), /packed data is invalid/);
    assert.throws(() => attempt(pack([[0, 0, 0, 2]])), /packed data is invalid/);
    assert.throws(() => attempt(pack([[0, 0, 0, 0]], [""])), /packed data is invalid/);
    for (const entry of [[-1, 0, 0, 0], [2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0]] as Array<[number, number, number, number]>) {
      assert.throws(() => attempt(pack([entry])), /outside region bounds/);
    }
    const brokenPrefix = pack([[0, 0, 0, 0]]);
    brokenPrefix.count = brokenPrefix.typeIds.length + 1;
    assert.throws(() => attempt(brokenPrefix), /packed data is invalid/);
    const invalidCount = createWorldMeshBatches([{ ...region, blockCount: 1_000_000_000_000 }])[0];
    assert.throws(() => packWorldMeshBatch(invalidCount, new Map([[region.key, pack([[0, 0, 0, 0]])]])), /packed data is invalid/);
  }
  console.log("world mesh source checks passed");
}

main();
