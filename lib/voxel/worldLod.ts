import { createPackedVoxelBlocks, type PackedVoxelBlocks } from "./packedBlocks";

export type WorldLodRegionSize = { x: number; y: number; z: number };

type Axis = keyof WorldLodRegionSize;
type Bucket = {
  x: number;
  y: number;
  z: number;
  counts: Map<number, number>;
};

const AXES: Axis[] = ["x", "y", "z"];

function assertWorldLodScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 1 || scale > 32 || (scale & (scale - 1)) !== 0) {
    throw new Error("World LOD scale must be a power of two from 1 to 32");
  }
}

function assertRegionSize(regionSize: WorldLodRegionSize): void {
  for (const axis of AXES) {
    if (!Number.isInteger(regionSize[axis]) || regionSize[axis] < 1) {
      throw new Error("World LOD region size must use positive integer dimensions");
    }
  }
}

function assertPackedPrefix(packed: PackedVoxelBlocks): void {
  if (
    !Number.isInteger(packed.count) || packed.count < 0 ||
    packed.count > packed.typeIds.length || packed.count * 3 > packed.positions.length
  ) {
    throw new Error("Packed voxel block count is invalid");
  }
}

function dominantTypeId(counts: Map<number, number>): number {
  let bestTypeId = -1;
  let bestCount = -1;
  for (const [typeId, count] of counts) {
    if (count > bestCount || (count === bestCount && typeId < bestTypeId)) {
      bestTypeId = typeId;
      bestCount = count;
    }
  }
  return bestTypeId;
}

export function createWorldLodPackedBlocks(
  packed: PackedVoxelBlocks,
  regionSize: WorldLodRegionSize,
  scale: number,
): PackedVoxelBlocks {
  assertWorldLodScale(scale);
  assertRegionSize(regionSize);
  assertPackedPrefix(packed);

  const yCells = Math.ceil(regionSize.y / scale);
  const zCells = Math.ceil(regionSize.z / scale);
  const buckets = new Map<number, Bucket>();

  for (let index = 0; index < packed.count; index += 1) {
    const x = packed.positions[index * 3]!;
    const y = packed.positions[index * 3 + 1]!;
    const z = packed.positions[index * 3 + 2]!;
    const typeId = packed.typeIds[index]!;

    if (x < 0 || x >= regionSize.x || y < 0 || y >= regionSize.y || z < 0 || z >= regionSize.z) {
      throw new Error("Packed block is outside region bounds");
    }
    if (typeId >= packed.typeNames.length) {
      throw new Error("Packed block type id is outside the palette");
    }
  }

  if (scale === 1) return packed;

  for (let index = 0; index < packed.count; index += 1) {
    const qx = Math.floor(packed.positions[index * 3]! / scale);
    const qy = Math.floor(packed.positions[index * 3 + 1]! / scale);
    const qz = Math.floor(packed.positions[index * 3 + 2]! / scale);
    const key = (qx * yCells + qy) * zCells + qz;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { x: qx, y: qy, z: qz, counts: new Map() };
      buckets.set(key, bucket);
    }
    const typeId = packed.typeIds[index]!;
    bucket.counts.set(typeId, (bucket.counts.get(typeId) ?? 0) + 1);
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
  const lod = createPackedVoxelBlocks(sorted.length);
  lod.typeNames = packed.typeNames;
  lod.count = sorted.length;

  for (let index = 0; index < sorted.length; index += 1) {
    const bucket = sorted[index]!;
    lod.positions[index * 3] = bucket.x;
    lod.positions[index * 3 + 1] = bucket.y;
    lod.positions[index * 3 + 2] = bucket.z;
    lod.typeIds[index] = dominantTypeId(bucket.counts);
  }

  return lod;
}
