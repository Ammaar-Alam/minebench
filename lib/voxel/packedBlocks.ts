import type { VoxelBlock, VoxelBuild } from "./types";

// Blocks cost roughly 80 bytes each as JS objects and 8 bytes each in typed
// arrays, plus one shared palette. Stream chunks are written directly into
// these arrays so their parsed objects can be released instead of retained for
// the lifetime of the lane.
export type PackedVoxelBlocks = {
  // x, y, z interleaved
  positions: Int16Array;
  typeIds: Uint16Array;
  typeNames: string[];
  // filled entries, which is below the array capacity while a stream is in flight
  count: number;
};

// A build whose blocks may live in packed form. Server-side builds and anything
// coming out of validation stay object-backed, so both shapes flow through the
// same viewer and mesh entry points.
export type RenderableVoxelBuild = VoxelBuild & { packed?: PackedVoxelBlocks };

const MIN_PACKED_CAPACITY = 1024;

// An exact request is honoured exactly: consumers that transfer these arrays
// read them to their full length, so trailing slack would render as blocks that
// were never sent.
function normalizeCapacity(capacity: number): number {
  if (!Number.isFinite(capacity) || capacity < 0) return MIN_PACKED_CAPACITY;
  return Math.ceil(capacity);
}

export function createPackedVoxelBlocks(capacity: number): PackedVoxelBlocks {
  const size = normalizeCapacity(capacity);
  return {
    positions: new Int16Array(size * 3),
    typeIds: new Uint16Array(size),
    typeNames: [],
    count: 0,
  };
}

export function packedVoxelBlocksCapacity(packed: PackedVoxelBlocks): number {
  return packed.typeIds.length;
}

// The announced total is a plan, not a guarantee, so growth has to be handled
// rather than trusted away.
function ensurePackedCapacity(packed: PackedVoxelBlocks, needed: number): void {
  const capacity = packedVoxelBlocksCapacity(packed);
  if (needed <= capacity) return;
  let next = Math.max(capacity, MIN_PACKED_CAPACITY);
  while (next < needed) next *= 2;
  const positions = new Int16Array(next * 3);
  positions.set(packed.positions.subarray(0, packed.count * 3));
  const typeIds = new Uint16Array(next);
  typeIds.set(packed.typeIds.subarray(0, packed.count));
  packed.positions = positions;
  packed.typeIds = typeIds;
}

// Preallocate to an announced total so a stream fills one allocation instead of
// growing through every power of two on its way there.
export function reservePackedVoxelBlocks(packed: PackedVoxelBlocks, capacity: number): void {
  if (!Number.isFinite(capacity) || capacity <= 0) return;
  ensurePackedCapacity(packed, Math.ceil(capacity));
}

export function appendPackedVoxelBlocks(
  packed: PackedVoxelBlocks,
  blocks: readonly VoxelBlock[],
): void {
  if (blocks.length === 0) return;
  ensurePackedCapacity(packed, packed.count + blocks.length);
  const typeIdByName = new Map<string, number>();
  for (let i = 0; i < packed.typeNames.length; i += 1) {
    typeIdByName.set(packed.typeNames[i], i);
  }
  let write = packed.count;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block) continue;
    packed.positions[write * 3] = block.x;
    packed.positions[write * 3 + 1] = block.y;
    packed.positions[write * 3 + 2] = block.z;
    let typeId = typeIdByName.get(block.type);
    if (typeId === undefined) {
      typeId = packed.typeNames.length;
      packed.typeNames.push(block.type);
      typeIdByName.set(block.type, typeId);
    }
    packed.typeIds[write] = typeId;
    write += 1;
  }
  packed.count = write;
}

export function packVoxelBlocks(blocks: readonly VoxelBlock[]): PackedVoxelBlocks {
  const packed = createPackedVoxelBlocks(blocks.length);
  appendPackedVoxelBlocks(packed, blocks);
  return packed;
}

// Materializes objects again. Only the paths that genuinely need them call this:
// main-thread meshing and client-side validation.
export function unpackVoxelBlocks(packed: PackedVoxelBlocks, limit?: number): VoxelBlock[] {
  const max =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.min(packed.count, Math.floor(limit)))
      : packed.count;
  const blocks: VoxelBlock[] = new Array(max);
  for (let i = 0; i < max; i += 1) {
    blocks[i] = {
      x: packed.positions[i * 3],
      y: packed.positions[i * 3 + 1],
      z: packed.positions[i * 3 + 2],
      type: packed.typeNames[packed.typeIds[i]] ?? "",
    };
  }
  return blocks;
}

// Trimmed copy with its own buffers, so handing blocks to the mesh worker as
// transferables never detaches the arrays the lane is still hydrating into.
export function copyPackedVoxelBlocks(
  packed: PackedVoxelBlocks,
  limit?: number,
): PackedVoxelBlocks {
  const count =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.min(packed.count, Math.floor(limit)))
      : packed.count;
  return {
    positions: packed.positions.slice(0, count * 3),
    typeIds: packed.typeIds.slice(0, count),
    typeNames: packed.typeNames.slice(),
    count,
  };
}

export function voxelBuildBlockCount(build: RenderableVoxelBuild | null | undefined): number {
  if (!build) return 0;
  return build.packed ? build.packed.count : build.blocks.length;
}

// Reference used to tell one build apart from another. Streaming mutates the
// same container in place, which is what keeps progressive rebuilds attached to
// the same identity.
export function voxelBuildBlocksRef(build: RenderableVoxelBuild): object {
  return build.packed ?? build.blocks;
}

export function toObjectBackedVoxelBuild(build: RenderableVoxelBuild): VoxelBuild {
  if (!build.packed) return build;
  const { packed, ...rest } = build;
  return { ...rest, blocks: unpackVoxelBlocks(packed) };
}
