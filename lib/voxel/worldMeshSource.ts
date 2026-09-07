import { decodeBinaryVoxelBuild, readBinaryVoxelBuildHeader } from "./binaryBuild";
import type { VoxelMeshPayload } from "./mesh";
import {
  createPackedVoxelBlocks,
  isPackedVoxelBlocks,
  reservePackedVoxelBlocks,
  type PackedVoxelBlocks,
} from "./packedBlocks";
import type { VoxelWorldBounds, VoxelWorldMixedRegion, VoxelWorldPartRef, VoxelWorldRegion } from "./world";
import { buildWorldRegionGreedyMeshPayload } from "./worldRegionMesh";

export type WorldMeshBatch = {
  bounds: VoxelWorldBounds;
  regions: VoxelWorldMixedRegion[];
  neighbors: VoxelWorldRegion[];
};

const AXES = ["x", "y", "z"] as const;
const BATCH_SIZE = 512;

function intersects(a: VoxelWorldBounds, b: VoxelWorldBounds, padding = 0): boolean {
  return AXES.every((axis) => a.origin[axis] - padding < b.origin[axis] + b.size[axis] &&
    a.origin[axis] + a.size[axis] + padding > b.origin[axis]);
}

export function createWorldMeshBatches(allRegions: readonly VoxelWorldRegion[]): WorldMeshBatch[] {
  const batches = new Map<string, WorldMeshBatch>();
  for (const region of allRegions) {
    if (region.kind !== "mixed") continue;
    const key = AXES.map((axis) => Math.floor(region.origin[axis] / BATCH_SIZE)).join(":");
    let batch = batches.get(key);
    if (!batch) {
      batch = { bounds: { origin: { ...region.origin }, size: { ...region.size } }, regions: [], neighbors: [] };
      batches.set(key, batch);
    }
    batch.regions.push(region);
    for (const axis of AXES) {
      const end = Math.max(batch.bounds.origin[axis] + batch.bounds.size[axis], region.origin[axis] + region.size[axis]);
      batch.bounds.origin[axis] = Math.min(batch.bounds.origin[axis], region.origin[axis]);
      batch.bounds.size[axis] = end - batch.bounds.origin[axis];
    }
  }
  for (const batch of batches.values()) {
    const owned = new Set(batch.regions.map((region) => region.key));
    batch.neighbors = allRegions.filter((region) => !owned.has(region.key) && intersects(batch.bounds, region, 1));
  }
  return Array.from(batches.values());
}

export function packWorldMeshBatch(
  batch: WorldMeshBatch,
  parts: ReadonlyMap<string, PackedVoxelBlocks>,
): { packed: PackedVoxelBlocks; halo: PackedVoxelBlocks } {
  const packed = createPackedVoxelBlocks(0);
  const halo = createPackedVoxelBlocks(0);
  const typeIds = new Map<string, number>();
  halo.typeNames = packed.typeNames;
  const haloKeys = new Set<number>();
  const yStride = batch.bounds.size.y + 2;
  const zStride = batch.bounds.size.z + 2;

  const typeIdFor = (name: string): number => {
    const found = typeIds.get(name);
    if (found !== undefined) return found;
    if (!name || typeof name !== "string") throw new Error("World mesh block type is invalid");
    const id = packed.typeNames.length;
    if (id > 65_535) throw new Error("Too many world mesh block types");
    packed.typeNames.push(name);
    typeIds.set(name, id);
    return id;
  };
  const append = (target: PackedVoxelBlocks, x: number, y: number, z: number, typeId: number) => {
    x -= batch.bounds.origin.x;
    y -= batch.bounds.origin.y;
    z -= batch.bounds.origin.z;
    if (target === halo) {
      if (x < -1 || y < -1 || z < -1 || x > batch.bounds.size.x || y > batch.bounds.size.y || z > batch.bounds.size.z) return;
      const key = ((x + 1) * yStride + y + 1) * zStride + z + 1;
      if (haloKeys.has(key)) return;
      haloKeys.add(key);
    }
    if (x < -32_768 || y < -32_768 || z < -32_768 || x > 32_767 || y > 32_767 || z > 32_767) {
      throw new Error("World mesh coordinates exceed the packed range");
    }
    if (target.count === target.typeIds.length) reservePackedVoxelBlocks(target, Math.max(1024, target.count * 2));
    const offset = target.count * 3;
    target.positions[offset] = x;
    target.positions[offset + 1] = y;
    target.positions[offset + 2] = z;
    target.typeIds[target.count] = typeId;
    target.count += 1;
  };
  const appendMixed = (region: VoxelWorldMixedRegion, target: PackedVoxelBlocks) => {
    const part = parts.get(region.key);
    if (!part) throw new Error(`World mesh region ${region.key} data is missing`);
    if (!isPackedVoxelBlocks(part) || part.count !== region.blockCount) {
      throw new Error(`World mesh region ${region.key} packed data is invalid`);
    }
    const remappedTypes = part.typeNames.map(typeIdFor);
    for (let index = 0; index < part.count; index += 1) {
      const x = part.positions[index * 3];
      const y = part.positions[index * 3 + 1];
      const z = part.positions[index * 3 + 2];
      if (x < 0 || y < 0 || z < 0 || x >= region.size.x || y >= region.size.y || z >= region.size.z) {
        throw new Error(`World mesh region ${region.key} block is outside region bounds`);
      }
      append(target, x + region.origin.x, y + region.origin.y, z + region.origin.z, remappedTypes[part.typeIds[index]]);
    }
  };

  for (const region of batch.regions) appendMixed(region, packed);
  for (const neighbor of batch.neighbors) {
    if (neighbor.kind === "mixed") {
      appendMixed(neighbor, halo);
      continue;
    }
    const typeId = typeIdFor(neighbor.type);
    for (const region of batch.regions) {
      if (!intersects(region, neighbor, 1)) continue;
      // only the six leaf-border slabs can affect visibility or ambient occlusion
      for (const axis of AXES) {
        for (const side of [-1, 1]) {
          const start = { ...region.origin };
          const end = { ...region.origin };
          for (const other of AXES) {
            start[other] -= 1;
            end[other] += region.size[other] + 1;
          }
          start[axis] = region.origin[axis] + (side < 0 ? -1 : region.size[axis]);
          end[axis] = start[axis] + 1;
          for (const other of AXES) {
            start[other] = Math.max(start[other], neighbor.origin[other]);
            end[other] = Math.min(end[other], neighbor.origin[other] + neighbor.size[other]);
          }
          for (let x = start.x; x < end.x; x += 1) {
            for (let y = start.y; y < end.y; y += 1) {
              for (let z = start.z; z < end.z; z += 1) append(halo, x, y, z, typeId);
            }
          }
        }
      }
    }
  }
  return { packed, halo };
}

export async function* buildWorldMeshPayloads(args: {
  regions: readonly VoxelWorldRegion[];
  sourceBuildSha256: string;
  paletteIds: string[];
  readPart: (ref: VoxelWorldPartRef) => Promise<Uint8Array>;
  throwIfCanceled?: () => void;
}): AsyncGenerator<{ bounds: VoxelWorldBounds; blockCount: number; payload: VoxelMeshPayload }> {
  for (const batch of createWorldMeshBatches(args.regions)) {
    args.throwIfCanceled?.();
    const parts = new Map<string, PackedVoxelBlocks>();
    const decodedParts = new Map<string, PackedVoxelBlocks>();
    for (const region of [...batch.regions, ...batch.neighbors]) {
      if (region.kind !== "mixed") continue;
      args.throwIfCanceled?.();
      let packed = decodedParts.get(region.data.key);
      if (!packed) {
        const bytes = await args.readPart(region.data);
        args.throwIfCanceled?.();
        const header = readBinaryVoxelBuildHeader(bytes);
        if (header.blockCount !== region.blockCount) {
          throw new Error(`Voxel world region ${region.key} block count mismatch`);
        }
        if (header.checksumPrefix !== Number.parseInt(args.sourceBuildSha256.slice(0, 8), 16)) {
          throw new Error(`Voxel world region ${region.key} source checksum mismatch`);
        }
        packed = decodeBinaryVoxelBuild(bytes);
        decodedParts.set(region.data.key, packed);
      }
      parts.set(region.key, packed);
    }
    args.throwIfCanceled?.();
    const { packed, halo } = packWorldMeshBatch(batch, parts);
    parts.clear();
    decodedParts.clear();
    const payload = buildWorldRegionGreedyMeshPayload(packed, args.paletteIds, { size: batch.bounds.size, halo });
    args.throwIfCanceled?.();
    yield { bounds: batch.bounds, blockCount: packed.count, payload };
  }
  args.throwIfCanceled?.();
}
