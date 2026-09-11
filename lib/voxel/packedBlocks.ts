import type { VoxelBlock, VoxelBox, VoxelBuild } from "./types";
import type { VoxelMeshFacts } from "./meshFacts";
import type { VoxelWorldDelivery } from "./world";

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

export type PackedVoxelBoxChunk = {
  start: number;
  // x1, y1, z1, x2, y2, z2 interleaved
  coordinates: Int16Array | Float64Array;
  typeIds: Uint16Array;
  count: number;
};

export type PackedVoxelBoxes = {
  chunks: PackedVoxelBoxChunk[];
  typeNames: string[];
  count: number;
};

export type PackedVoxelBoxRecord = VoxelBox & { typeId: number };

// A build whose blocks may live in packed form
export type RenderableVoxelBuild = VoxelBuild & {
  meshFacts?: VoxelMeshFacts;
  world?: VoxelWorldDelivery;
};

const MIN_PACKED_CAPACITY = 1024;
const PACKED_BOX_CHUNK_SIZE = 16_384;
const INT16_MIN = -32_768;
const INT16_MAX = 32_767;

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

export function createPackedVoxelBoxes(): PackedVoxelBoxes {
  return { chunks: [], typeNames: [], count: 0 };
}

export function packedVoxelBlocksCapacity(packed: PackedVoxelBlocks): number {
  return packed.typeIds.length;
}

// The announced total is a plan, not a guarantee, so growth has to be handled
// rather than trusted away.
function ensurePackedCapacity(packed: PackedVoxelBlocks, needed: number, exact = false): void {
  const capacity = packedVoxelBlocksCapacity(packed);
  if (needed <= capacity) return;
  let next = Math.max(capacity, MIN_PACKED_CAPACITY);
  while (next < needed) next *= 2;
  if (exact) next = needed;
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
  ensurePackedCapacity(packed, Math.ceil(capacity), true);
}

export function appendCoalescedVoxelBox(boxes: VoxelBox[], box: VoxelBox): void {
  const last = boxes.at(-1);
  if (last?.type === box.type && box.x1 <= box.x2 && box.y1 <= box.y2 && box.z1 <= box.z2 && last.x1 <= last.x2 && last.y1 <= last.y2 && last.z1 <= last.z2) {
    for (const axis of ["x", "y", "z"] as const) {
      const min = `${axis}1` as const;
      const max = `${axis}2` as const;
      if (last[max] + 1 !== box[min] && box[max] + 1 !== last[min]) continue;
      const others = axis === "x" ? ["y", "z"] as const : axis === "y" ? ["x", "z"] as const : ["x", "y"] as const;
      if (others.some((other) => last[`${other}1`] !== box[`${other}1`] || last[`${other}2`] !== box[`${other}2`])) continue;
      last[min] = Math.min(last[min], box[min]);
      last[max] = Math.max(last[max], box[max]);
      return;
    }
  }
  boxes.push(box);
}

function boxFitsInt16(box: VoxelBox): boolean {
  return (
    box.x1 >= INT16_MIN && box.x1 <= INT16_MAX &&
    box.y1 >= INT16_MIN && box.y1 <= INT16_MAX &&
    box.z1 >= INT16_MIN && box.z1 <= INT16_MAX &&
    box.x2 >= INT16_MIN && box.x2 <= INT16_MAX &&
    box.y2 >= INT16_MIN && box.y2 <= INT16_MAX &&
    box.z2 >= INT16_MIN && box.z2 <= INT16_MAX
  );
}

function packedBoxTypeId(packed: PackedVoxelBoxes, type: string): number {
  let typeId = packed.typeNames.indexOf(type);
  if (typeId >= 0) return typeId;
  typeId = packed.typeNames.length;
  if (typeId > 65_535) throw new Error("Too many packed box types");
  packed.typeNames.push(type);
  return typeId;
}

function createPackedBoxChunk(start: number, useInt16: boolean): PackedVoxelBoxChunk {
  return {
    start,
    coordinates: useInt16
      ? new Int16Array(PACKED_BOX_CHUNK_SIZE * 6)
      : new Float64Array(PACKED_BOX_CHUNK_SIZE * 6),
    typeIds: new Uint16Array(PACKED_BOX_CHUNK_SIZE),
    count: 0,
  };
}

function promotePackedBoxChunkToFloat64(chunk: PackedVoxelBoxChunk): void {
  if (chunk.coordinates instanceof Float64Array) return;
  const coordinates = new Float64Array(chunk.coordinates.length);
  coordinates.set(chunk.coordinates);
  chunk.coordinates = coordinates;
}

function writePackedBox(chunk: PackedVoxelBoxChunk, index: number, box: VoxelBox, typeId: number): void {
  const offset = index * 6;
  chunk.coordinates[offset] = box.x1;
  chunk.coordinates[offset + 1] = box.y1;
  chunk.coordinates[offset + 2] = box.z1;
  chunk.coordinates[offset + 3] = box.x2;
  chunk.coordinates[offset + 4] = box.y2;
  chunk.coordinates[offset + 5] = box.z2;
  chunk.typeIds[index] = typeId;
}

function tryCoalescePackedVoxelBox(packed: PackedVoxelBoxes, box: VoxelBox, typeId: number): boolean {
  const chunk = packed.chunks.at(-1);
  if (!chunk || chunk.count === 0 || chunk.typeIds[chunk.count - 1] !== typeId) return false;
  const offset = (chunk.count - 1) * 6;
  const last: VoxelBox = {
    x1: chunk.coordinates[offset]!,
    y1: chunk.coordinates[offset + 1]!,
    z1: chunk.coordinates[offset + 2]!,
    x2: chunk.coordinates[offset + 3]!,
    y2: chunk.coordinates[offset + 4]!,
    z2: chunk.coordinates[offset + 5]!,
    type: box.type,
  };
  if (!(box.x1 <= box.x2 && box.y1 <= box.y2 && box.z1 <= box.z2 && last.x1 <= last.x2 && last.y1 <= last.y2 && last.z1 <= last.z2)) {
    return false;
  }
  for (const axis of ["x", "y", "z"] as const) {
    const min = `${axis}1` as const;
    const max = `${axis}2` as const;
    if (last[max] + 1 !== box[min] && box[max] + 1 !== last[min]) continue;
    const others = axis === "x" ? ["y", "z"] as const : axis === "y" ? ["x", "z"] as const : ["x", "y"] as const;
    if (others.some((other) => last[`${other}1`] !== box[`${other}1`] || last[`${other}2`] !== box[`${other}2`])) continue;
    last[min] = Math.min(last[min], box[min]);
    last[max] = Math.max(last[max], box[max]);
    if (chunk.coordinates instanceof Int16Array && !boxFitsInt16(last)) promotePackedBoxChunkToFloat64(chunk);
    writePackedBox(chunk, chunk.count - 1, last, typeId);
    return true;
  }
  return false;
}

export function appendPackedVoxelBox(packed: PackedVoxelBoxes, box: VoxelBox, coalesce = true): void {
  if (!Number.isInteger(box.x1) || !Number.isInteger(box.y1) || !Number.isInteger(box.z1) ||
      !Number.isInteger(box.x2) || !Number.isInteger(box.y2) || !Number.isInteger(box.z2)) {
    throw new Error("Box coordinates must be integers");
  }
  const typeId = packedBoxTypeId(packed, box.type);
  if (coalesce && tryCoalescePackedVoxelBox(packed, box, typeId)) return;
  const useInt16 = boxFitsInt16(box);
  let chunk = packed.chunks.at(-1);
  if (!chunk || chunk.count === chunk.typeIds.length) {
    chunk = createPackedBoxChunk(packed.count, useInt16);
    packed.chunks.push(chunk);
  } else if (chunk.coordinates instanceof Int16Array && !useInt16) {
    promotePackedBoxChunkToFloat64(chunk);
  }
  writePackedBox(chunk, chunk.count, box, typeId);
  chunk.count += 1;
  packed.count += 1;
}

export function appendPackedVoxelBoxes(packed: PackedVoxelBoxes, boxes: readonly VoxelBox[], coalesce = true): void {
  for (const box of boxes) appendPackedVoxelBox(packed, box, coalesce);
}

function findPackedBoxChunk(packed: PackedVoxelBoxes, index: number): PackedVoxelBoxChunk | null {
  let low = 0;
  let high = packed.chunks.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const chunk = packed.chunks[mid]!;
    if (index < chunk.start) high = mid - 1;
    else if (index >= chunk.start + chunk.count) low = mid + 1;
    else return chunk;
  }
  return null;
}

export function readPackedVoxelBox(
  packed: PackedVoxelBoxes,
  index: number,
  target: PackedVoxelBoxRecord,
): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= packed.count) return false;
  const chunk = findPackedBoxChunk(packed, index);
  if (!chunk) return false;
  const localIndex = index - chunk.start;
  const offset = localIndex * 6;
  const typeId = chunk.typeIds[localIndex]!;
  target.x1 = chunk.coordinates[offset]!;
  target.y1 = chunk.coordinates[offset + 1]!;
  target.z1 = chunk.coordinates[offset + 2]!;
  target.x2 = chunk.coordinates[offset + 3]!;
  target.y2 = chunk.coordinates[offset + 4]!;
  target.z2 = chunk.coordinates[offset + 5]!;
  target.typeId = typeId;
  target.type = packed.typeNames[typeId] ?? "";
  return target.type.length > 0;
}

export function isPackedVoxelBlocks(value: unknown): value is PackedVoxelBlocks {
  if (!value || typeof value !== "object") return false;
  const packed = value as PackedVoxelBlocks;
  if (
    !(packed.positions instanceof Int16Array) || !(packed.typeIds instanceof Uint16Array) ||
    !Number.isInteger(packed.count) || packed.count < 0 ||
    packed.count > packed.typeIds.length || packed.count * 3 > packed.positions.length ||
    !Array.isArray(packed.typeNames) || packed.typeNames.length > 65_536
  ) return false;
  for (let index = 0; index < packed.typeNames.length; index += 1) {
    if (typeof packed.typeNames[index] !== "string" || packed.typeNames[index]!.length === 0) return false;
  }
  for (let index = 0; index < packed.count; index += 1) {
    if (packed.typeIds[index]! >= packed.typeNames.length) return false;
  }
  return true;
}

export function isPackedVoxelBoxes(value: unknown): value is PackedVoxelBoxes {
  if (!value || typeof value !== "object") return false;
  const packed = value as PackedVoxelBoxes;
  if (!Array.isArray(packed.chunks) || !Array.isArray(packed.typeNames) ||
      !Number.isInteger(packed.count) || packed.count < 0 || packed.typeNames.length > 65_536) {
    return false;
  }
  for (let index = 0; index < packed.typeNames.length; index += 1) {
    if (typeof packed.typeNames[index] !== "string" || packed.typeNames[index]!.length === 0) return false;
  }
  let expectedStart = 0;
  for (const chunk of packed.chunks) {
    if (!chunk || typeof chunk !== "object" ||
        !(chunk.coordinates instanceof Int16Array || chunk.coordinates instanceof Float64Array) ||
        !(chunk.typeIds instanceof Uint16Array) ||
        !Number.isInteger(chunk.start) || chunk.start !== expectedStart ||
        !Number.isInteger(chunk.count) || chunk.count < 0 || chunk.count > chunk.typeIds.length ||
        chunk.coordinates.length < chunk.typeIds.length * 6) {
      return false;
    }
    for (let index = 0; index < chunk.count; index += 1) {
      if (chunk.typeIds[index]! >= packed.typeNames.length) return false;
    }
    if (chunk.coordinates instanceof Float64Array) {
      for (let index = 0; index < chunk.count * 6; index += 1) {
        if (!Number.isInteger(chunk.coordinates[index])) return false;
      }
    }
    expectedStart += chunk.count;
  }
  return expectedStart === packed.count;
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
    if (
      !Number.isInteger(block.x) || !Number.isInteger(block.y) || !Number.isInteger(block.z) ||
      block.x < -32_768 || block.x > 32_767 || block.y < -32_768 || block.y > 32_767 ||
      block.z < -32_768 || block.z > 32_767
    ) throw new Error("Block coordinates exceed the packed coordinate range");
    packed.positions[write * 3] = block.x;
    packed.positions[write * 3 + 1] = block.y;
    packed.positions[write * 3 + 2] = block.z;
    let typeId = typeIdByName.get(block.type);
    if (typeId === undefined) {
      typeId = packed.typeNames.length;
      if (typeId > 65_535) throw new Error("Too many packed block types");
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

export function* voxelBuildBoxes(build: RenderableVoxelBuild): Generator<VoxelBox> {
  yield* (build.boxes ?? []);
  if (!build.packedBoxes) return;
  const box: PackedVoxelBoxRecord = { x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0, type: "", typeId: 0 };
  for (let index = 0; index < build.packedBoxes.count; index += 1) {
    if (!readPackedVoxelBox(build.packedBoxes, index, box)) continue;
    yield { x1: box.x1, y1: box.y1, z1: box.z1, x2: box.x2, y2: box.y2, z2: box.z2, type: box.type };
  }
}

export function unpackVoxelBoxes(packed: PackedVoxelBoxes): VoxelBox[] {
  return Array.from(voxelBuildBoxes({ version: "1.0", blocks: [], packedBoxes: packed }));
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
  if (build.world) return build.world.manifest.exactBlockCount;
  return build.packed ? build.packed.count : build.blocks.length;
}

export function voxelBuildBlockAt(
  build: RenderableVoxelBuild,
  index: number,
): VoxelBlock | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= voxelBuildBlockCount(build)) {
    return undefined;
  }
  if (!build.packed) return build.blocks[index];
  const { positions, typeIds, typeNames } = build.packed;
  return {
    x: positions[index * 3]!,
    y: positions[index * 3 + 1]!,
    z: positions[index * 3 + 2]!,
    type: typeNames[typeIds[index]!]!,
  };
}

export function sortPackedVoxelBlocks(packed: PackedVoxelBlocks): void {
  const { positions, typeIds, typeNames, count } = packed;
  const order = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) order[index] = index;
  order.sort((a, b) =>
    positions[a * 3]! - positions[b * 3]! ||
    positions[a * 3 + 1]! - positions[b * 3 + 1]! ||
    positions[a * 3 + 2]! - positions[b * 3 + 2]! ||
    typeNames[typeIds[a]!]!.localeCompare(typeNames[typeIds[b]!]!),
  );

  // Apply permutation cycles without allocating another set of block buffers
  for (let start = 0; start < count; start += 1) {
    if (order[start] === start) continue;
    const x = positions[start * 3]!;
    const y = positions[start * 3 + 1]!;
    const z = positions[start * 3 + 2]!;
    const typeId = typeIds[start]!;
    let current = start;
    while (order[current] !== start) {
      const next = order[current]!;
      positions[current * 3] = positions[next * 3]!;
      positions[current * 3 + 1] = positions[next * 3 + 1]!;
      positions[current * 3 + 2] = positions[next * 3 + 2]!;
      typeIds[current] = typeIds[next]!;
      order[current] = current;
      current = next;
    }
    positions[current * 3] = x;
    positions[current * 3 + 1] = y;
    positions[current * 3 + 2] = z;
    typeIds[current] = typeId;
    order[current] = current;
  }
}

// Reference used to tell one build apart from another. Streaming mutates the
// same container in place, which is what keeps progressive rebuilds attached to
// the same identity.
export function voxelBuildBlocksRef(build: RenderableVoxelBuild): object {
  return build.world ?? build.packed ?? build.packedBoxes ?? build.blocks;
}

export function toObjectBackedVoxelBuild(build: RenderableVoxelBuild): VoxelBuild {
  if (build.world) throw new Error("This world is too large for this export format. Download its JSON instead.");
  if (!build.packed && !build.packedBoxes) return build;
  const { packed, packedBoxes, ...rest } = build;
  return {
    ...rest,
    ...(packedBoxes ? { boxes: Array.from(voxelBuildBoxes(build)) } : {}),
    blocks: packed ? unpackVoxelBlocks(packed) : rest.blocks,
  };
}
