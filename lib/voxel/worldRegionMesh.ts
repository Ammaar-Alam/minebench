import { ATLAS, hasAtlasKey } from "@/lib/blocks/atlas";
import { getRenderKind } from "@/lib/blocks/registry";
import { getTextureKey, type Face } from "@/lib/blocks/textures";
import {
  computeFaceAO,
  computeVisibleFaceMask,
  DIRS,
  SpatialBlockTable,
  type Direction,
  type SpatialBlockLookup,
} from "@/lib/voxel/ambientOcclusion";
import type { SerializedBuildBounds, TransferableVoxelBlocks, VoxelMeshPayload } from "@/lib/voxel/mesh";
import type { PackedVoxelBlocks } from "@/lib/voxel/packedBlocks";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";
import type { VoxelPoint } from "@/lib/voxel/types";
import {
  appendWorldQuad,
  createWorldQuadBucket,
  packWorldQuadAo,
  serializeWorldQuadBucket,
  WORLD_QUAD_FIELD_MAX,
  WORLD_QUAD_TINT_GRASS,
  WORLD_QUAD_TINT_LEAVES,
  WORLD_QUAD_TINT_WATER,
  WORLD_QUAD_TINT_WHITE,
  worldQuadFlipDiagonal,
  type WorldQuadBucket,
  type WorldQuadPayload,
  type WorldQuadTintIndex,
} from "@/lib/voxel/worldQuadData";

export type { WorldQuadPayload } from "@/lib/voxel/worldQuadData";

export type WorldRegionMeshOptions = {
  size: VoxelPoint;
  halo?: PackedVoxelBlocks;
};

type Axis = "x" | "y" | "z";
type BucketName = "opaque" | "cutout" | "transparent" | "water" | "emissive";

type PreparedWorldRegionMesh = {
  blocks: TransferableVoxelBlocks;
  allowed: Set<string>;
  materialOccluding: Uint8Array;
  paletteTypeIds: Uint16Array;
  table: SpatialBlockLookup;
  visibleFaceMasks: Uint8Array;
  filteredBlockCount: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  cx: number;
  cy: number;
  cz: number;
};

type FacePlane = {
  direction: Direction;
  directionIndex: number;
  plane: number;
  bucket: BucketName;
  tintIndex: WorldQuadTintIndex;
  atlasWord: number;
  packedAoByte: number;
  flipDiagonal: 0 | 1;
  cells: number[];
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
};

type CoordIndex = 0 | 1 | 2;

type FaceMetadata = {
  direction: Direction;
  directionIndex: number;
  bucket: BucketName;
  atlasWord: number | null;
  tintIndex: WorldQuadTintIndex;
  planeAxis: CoordIndex;
  planeOffset: 0 | 1;
  uAxis: CoordIndex;
  vAxis: CoordIndex;
  dimensionWidth: number;
};

type TypeMetadata = {
  faces: FaceMetadata[];
};

type WorldQuadBuckets = Record<BucketName, WorldQuadBucket>;

const WATER_BLOCK_ID = "water";
const INVALID_TYPE = 0xffff;
const ATLAS_PIXEL_MAX = 0xffff;
const DENSE_LOOKUP_MAX_BYTES = 96 * 1024 * 1024;

type WorldRegionBlockTable = SpatialBlockLookup & {
  set(x: number, y: number, z: number, typeId: number): void;
};

class DenseWorldRegionBlockTable implements WorldRegionBlockTable {
  private readonly width: number;
  private readonly height: number;
  private readonly depth: number;
  private readonly values: Uint8Array | Uint16Array;

  constructor(size: VoxelPoint, bytesPerCell: 1 | 2) {
    this.width = size.x + 2;
    this.height = size.y + 2;
    this.depth = size.z + 2;
    const cells = this.width * this.height * this.depth;
    this.values = bytesPerCell === 1 ? new Uint8Array(cells) : new Uint16Array(cells);
  }

  set(x: number, y: number, z: number, typeId: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || z < 0 || z >= this.depth) return;
    this.values[(x * this.height + y) * this.depth + z] = typeId + 1;
  }

  get(x: number, y: number, z: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || z < 0 || z >= this.depth) return -1;
    const value = this.values[(x * this.height + y) * this.depth + z]!;
    return value === 0 ? -1 : value - 1;
  }
}

function createWorldRegionBlockTable(
  size: VoxelPoint,
  paletteSize: number,
  capacity: number,
): WorldRegionBlockTable {
  const bytesPerCell = paletteSize <= 0xff ? 1 : paletteSize <= 0xffff ? 2 : null;
  const cells = (size.x + 2) * (size.y + 2) * (size.z + 2);
  // ponytail: fixed dense lookup cap fallback sparse if mixed batches exceed it
  if (bytesPerCell && Number.isSafeInteger(cells) && cells * bytesPerCell <= DENSE_LOOKUP_MAX_BYTES) {
    return new DenseWorldRegionBlockTable(size, bytesPerCell);
  }
  return new SpatialBlockTable(capacity);
}

function assertRegionSize(size: VoxelPoint): void {
  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isInteger(size[axis]) || size[axis] < 1) {
      throw new Error("World region mesh size must use positive integer dimensions");
    }
    if (size[axis] > WORLD_QUAD_FIELD_MAX) {
      throw new Error("World region mesh dimensions must fit compact quad fields");
    }
  }
}

function assertPackedPrefix(packed: PackedVoxelBlocks, label: string): void {
  if (
    !Number.isInteger(packed.count) || packed.count < 0 ||
    packed.count > packed.typeIds.length || packed.count * 3 > packed.positions.length
  ) {
    throw new Error(`${label} block count is invalid`);
  }
}

function isInsideTarget(size: VoxelPoint, x: number, y: number, z: number): boolean {
  return x >= 0 && x < size.x && y >= 0 && y < size.y && z >= 0 && z < size.z;
}

function assertTargetCoord(size: VoxelPoint, x: number, y: number, z: number): void {
  if (!isInsideTarget(size, x, y, z)) {
    throw new Error("World region mesh block is outside region bounds");
  }
}

function isInsideHalo(size: VoxelPoint, x: number, y: number, z: number): boolean {
  return x >= -1 && x <= size.x && y >= -1 && y <= size.y && z >= -1 && z <= size.z;
}

function mapTypeIds(typeNames: readonly string[], allowedBlockIds: readonly string[]): Uint16Array {
  const typeIds = new Uint16Array(typeNames.length);
  typeIds.fill(INVALID_TYPE);
  const paletteIds = new Map<string, number>();
  for (let index = 0; index < allowedBlockIds.length; index += 1) {
    paletteIds.set(allowedBlockIds[index]!, index);
  }
  for (let index = 0; index < typeNames.length; index += 1) {
    const mapped = paletteIds.get(typeNames[index]!);
    if (mapped !== undefined) typeIds[index] = mapped;
  }
  return typeIds;
}

function tableCoordinate(value: number): number {
  return value + 1;
}

function buildBounds(prepared: PreparedWorldRegionMesh): SerializedBuildBounds {
  const min: [number, number, number] = [
    prepared.minX - prepared.cx,
    prepared.minY - prepared.cy,
    prepared.minZ - prepared.cz,
  ];
  const max: [number, number, number] = [
    prepared.maxX - prepared.cx + 1,
    prepared.maxY - prepared.cy + 1,
    prepared.maxZ - prepared.cz + 1,
  ];
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const dx = max[0] - center[0];
  const dy = max[1] - center[1];
  const dz = max[2] - center[2];
  return { min, max, center, radius: Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz)) };
}

function bucketNameFor(type: string): BucketName {
  if (type === WATER_BLOCK_ID) return "water";
  const kind = getRenderKind(type) ?? "opaque";
  if (kind === "transparent") return "transparent";
  if (kind === "cutout") return "cutout";
  if (kind === "emissive") return "emissive";
  return "opaque";
}

function bucketFor(name: BucketName, buckets: WorldQuadBuckets): WorldQuadBucket {
  if (name === "water") return buckets.water;
  if (name === "transparent") return buckets.transparent;
  if (name === "cutout") return buckets.cutout;
  if (name === "emissive") return buckets.emissive;
  return buckets.opaque;
}

function tintIndexFor(blockType: string, face: Face): WorldQuadTintIndex {
  if (blockType === "oak_leaves") return WORLD_QUAD_TINT_LEAVES;
  if (blockType === WATER_BLOCK_ID) return WORLD_QUAD_TINT_WATER;
  if (blockType === "grass_block" && face === "up") return WORLD_QUAD_TINT_GRASS;
  return WORLD_QUAD_TINT_WHITE;
}

function flatAo(ao: readonly [number, number, number, number] | undefined): number | null {
  if (!ao) return null;
  return ao[0] === ao[1] && ao[0] === ao[2] && ao[0] === ao[3] ? ao[0] : null;
}

function axisIndex(axis: Axis): CoordIndex {
  if (axis === "x") return 0;
  if (axis === "y") return 1;
  return 2;
}

function coordinate(axis: CoordIndex, x: number, y: number, z: number): number {
  if (axis === 0) return x;
  if (axis === 1) return y;
  return z;
}

function faceAxes(face: Face, bucket?: BucketName): { u: Axis; v: Axis } {
  switch (face) {
    case "east":
    case "west":
      if (bucket === "water") return { u: "y", v: "z" };
      return { u: "z", v: "y" };
    case "north":
    case "south":
      return { u: "x", v: "y" };
    case "up":
    case "down":
      return { u: "x", v: "z" };
  }
}

function faceDimensions(face: Face, size: VoxelPoint, bucket?: BucketName): { width: number; height: number } {
  const axes = faceAxes(face, bucket);
  return { width: size[axes.u], height: size[axes.v] };
}

function facePlaneSpec(face: Face): { axis: CoordIndex; offset: 0 | 1 } {
  switch (face) {
    case "east": return { axis: 0, offset: 1 };
    case "west": return { axis: 0, offset: 0 };
    case "north": return { axis: 2, offset: 0 };
    case "south": return { axis: 2, offset: 1 };
    case "up": return { axis: 1, offset: 1 };
    case "down": return { axis: 1, offset: 0 };
  }
}

function atlasWordFor(textureKey: string, bucket: BucketName): number | null {
  if (bucket === "water") return 0;
  if (!hasAtlasKey(textureKey)) return null;
  const atlasEntry = ATLAS.keys[textureKey];
  const u0 = atlasEntry.x;
  const v0 = ATLAS.atlasHeight - atlasEntry.y - atlasEntry.h;
  if (
    !Number.isInteger(u0) || !Number.isInteger(v0) ||
    u0 < 0 || v0 < 0 || u0 > ATLAS_PIXEL_MAX || v0 > ATLAS_PIXEL_MAX
  ) {
    throw new Error("World region mesh atlas coordinates exceed compact quad fields");
  }
  return (u0 | (v0 << 16)) >>> 0;
}

function buildTypeMetadata(typeNames: readonly string[], allowed: ReadonlySet<string>, size: VoxelPoint): Array<TypeMetadata | null> {
  return typeNames.map((type) => {
    if (!allowed.has(type)) return null;
    const bucket = bucketNameFor(type);
    return {
      faces: DIRS.map((direction, directionIndex) => {
        const textureKey = getTextureKey(type, direction.face);
        const axes = faceAxes(direction.face, bucket);
        const dimensions = faceDimensions(direction.face, size, bucket);
        const plane = facePlaneSpec(direction.face);
        const tintIndex = tintIndexFor(type, direction.face);
        return {
          direction,
          directionIndex,
          bucket,
          atlasWord: atlasWordFor(textureKey, bucket),
          tintIndex,
          planeAxis: plane.axis,
          planeOffset: plane.offset,
          uAxis: axisIndex(axes.u),
          vAxis: axisIndex(axes.v),
          dimensionWidth: dimensions.width,
        };
      }),
    };
  });
}

function assertQuadField(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > WORLD_QUAD_FIELD_MAX) {
    throw new Error(`World region mesh ${name} exceeds compact quad fields`);
  }
}

function assertQuadSpan(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > WORLD_QUAD_FIELD_MAX) {
    throw new Error(`World region mesh ${name} exceeds compact quad fields`);
  }
}

function appendFaceRect(
  buckets: WorldQuadBuckets,
  plane: FacePlane,
  u: number,
  v: number,
  width: number,
  height: number,
) {
  assertQuadField("plane", plane.plane);
  assertQuadField("u", u);
  assertQuadField("v", v);
  assertQuadSpan("width", width);
  assertQuadSpan("height", height);

  appendWorldQuad(
    bucketFor(plane.bucket, buckets),
    (plane.plane | (u << 10) | (v << 20)) >>> 0,
    (width | (height << 10) | (plane.directionIndex << 20)) >>> 0,
    plane.atlasWord,
    (plane.tintIndex | (plane.packedAoByte << 2) | (plane.flipDiagonal << 10)) >>> 0,
  );
}

function faceKey(
  plane: number,
  typeId: number,
  directionIndex: number,
  ao: readonly [number, number, number, number] | undefined,
  packedAoByte: number,
): number | null {
  const flat = flatAo(ao);
  if (ao && flat === null) return null;
  return ((typeId * DIRS.length + directionIndex) * (WORLD_QUAD_FIELD_MAX + 1) + plane) * 256 + packedAoByte;
}

function appendMergedPlane(
  buckets: WorldQuadBuckets,
  plane: FacePlane,
  size: VoxelPoint,
) {
  const { width } = faceDimensions(plane.direction.face, size, plane.bucket);
  const maskWidth = plane.maxU - plane.minU + 1;
  const maskHeight = plane.maxV - plane.minV + 1;
  const mask = new Uint8Array(maskWidth * maskHeight);
  for (const cell of plane.cells) {
    const u = cell % width;
    const v = Math.floor(cell / width);
    mask[(v - plane.minV) * maskWidth + u - plane.minU] = 1;
  }

  for (let v = 0; v < maskHeight; v += 1) {
    const sourceV = v + plane.minV;
    for (let u = 0; u < maskWidth; u += 1) {
      const sourceU = u + plane.minU;
      const idx = v * maskWidth + u;
      if (mask[idx] === 0) continue;

      let rectWidth = 1;
      while (u + rectWidth < maskWidth && mask[v * maskWidth + u + rectWidth] === 1) rectWidth += 1;

      let rectHeight = 1;
      outer: while (v + rectHeight < maskHeight) {
        for (let x = 0; x < rectWidth; x += 1) {
          if (mask[(v + rectHeight) * maskWidth + u + x] === 0) break outer;
        }
        rectHeight += 1;
      }

      for (let dy = 0; dy < rectHeight; dy += 1) {
        mask.fill(0, (v + dy) * maskWidth + u, (v + dy) * maskWidth + u + rectWidth);
      }

      appendFaceRect(buckets, plane, sourceU, sourceV, rectWidth, rectHeight);
    }
  }
}

function prepareWorldRegionMesh(
  blocks: TransferableVoxelBlocks,
  allowedBlockIds: string[],
  opts: WorldRegionMeshOptions,
): PreparedWorldRegionMesh {
  assertRegionSize(opts.size);
  assertPackedPrefix(blocks, "World region mesh");
  if (opts.halo) assertPackedPrefix(opts.halo, "World region mesh halo");

  const allowed = new Set(allowedBlockIds);
  const paletteTypeIds = mapTypeIds(blocks.typeNames, allowedBlockIds);
  const haloPaletteTypeIds = opts.halo ? mapTypeIds(opts.halo.typeNames, allowedBlockIds) : null;
  const materialOccluding = new Uint8Array(allowedBlockIds.length);
  for (let typeId = 0; typeId < allowedBlockIds.length; typeId += 1) {
    materialOccluding[typeId] = isVoxelOccluder(allowedBlockIds[typeId]!) ? 1 : 0;
  }

  const table = createWorldRegionBlockTable(opts.size, allowedBlockIds.length, blocks.count + (opts.halo?.count ?? 0));
  const visibleFaceMasks = new Uint8Array(blocks.count);
  let filteredBlockCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  if (opts.halo && haloPaletteTypeIds) {
    for (let index = 0; index < opts.halo.count; index += 1) {
      const typeId = haloPaletteTypeIds[opts.halo.typeIds[index]!] ?? INVALID_TYPE;
      if (typeId === INVALID_TYPE) continue;
      const x = opts.halo.positions[index * 3]!;
      const y = opts.halo.positions[index * 3 + 1]!;
      const z = opts.halo.positions[index * 3 + 2]!;
      if (!isInsideHalo(opts.size, x, y, z)) continue;
      table.set(tableCoordinate(x), tableCoordinate(y), tableCoordinate(z), typeId);
    }
  }

  for (let index = 0; index < blocks.count; index += 1) {
    const typeId = paletteTypeIds[blocks.typeIds[index]!] ?? INVALID_TYPE;
    if (typeId === INVALID_TYPE) continue;
    const x = blocks.positions[index * 3]!;
    const y = blocks.positions[index * 3 + 1]!;
    const z = blocks.positions[index * 3 + 2]!;
    assertTargetCoord(opts.size, x, y, z);
    table.set(tableCoordinate(x), tableCoordinate(y), tableCoordinate(z), typeId);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  for (let index = 0; index < blocks.count; index += 1) {
    const typeId = paletteTypeIds[blocks.typeIds[index]!] ?? INVALID_TYPE;
    if (typeId === INVALID_TYPE) continue;
    const x = blocks.positions[index * 3]!;
    const y = blocks.positions[index * 3 + 1]!;
    const z = blocks.positions[index * 3 + 2]!;
    const visibleFaceMask = computeVisibleFaceMask(tableCoordinate(x), tableCoordinate(y), tableCoordinate(z), typeId, table, materialOccluding);
    if (visibleFaceMask === 0) continue;
    visibleFaceMasks[index] = visibleFaceMask;
    filteredBlockCount += 1;
  }

  if (!Number.isFinite(minX)) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }

  return {
    blocks,
    allowed,
    materialOccluding,
    paletteTypeIds,
    table,
    visibleFaceMasks,
    filteredBlockCount,
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    cx: (minX + maxX + 1) / 2,
    cy: minY,
    cz: (minZ + maxZ + 1) / 2,
  };
}

export function buildWorldRegionGreedyMeshPayload(
  blocks: TransferableVoxelBlocks,
  allowedBlockIds: string[],
  opts: WorldRegionMeshOptions,
): VoxelMeshPayload {
  const prepared = prepareWorldRegionMesh(blocks, allowedBlockIds, opts);
  const buckets: WorldQuadBuckets = {
    opaque: createWorldQuadBucket(),
    cutout: createWorldQuadBucket(),
    transparent: createWorldQuadBucket(),
    water: createWorldQuadBucket(),
    emissive: createWorldQuadBucket(),
  };
  const planes = new Map<number, FacePlane>();
  const { blocks: packed, paletteTypeIds } = prepared;
  const typeMetadata = buildTypeMetadata(packed.typeNames, prepared.allowed, opts.size);

  for (let index = 0; index < packed.count; index += 1) {
    const visibleFaceMask = prepared.visibleFaceMasks[index]!;
    if (visibleFaceMask === 0) continue;
    const sourceTypeId = packed.typeIds[index]!;
    const paletteTypeId = paletteTypeIds[sourceTypeId] ?? INVALID_TYPE;
    if (paletteTypeId === INVALID_TYPE) continue;
    const metadata = typeMetadata[sourceTypeId];
    if (!metadata) continue;
    const x = packed.positions[index * 3]!;
    const y = packed.positions[index * 3 + 1]!;
    const z = packed.positions[index * 3 + 2]!;

    for (const face of metadata.faces) {
      if ((visibleFaceMask & (1 << face.directionIndex)) === 0) continue;
      const direction = face.direction;
      const atlasWord = face.atlasWord;
      if (atlasWord === null) continue;
      const ao = face.bucket === "emissive" || face.bucket === "water"
        ? undefined
        : computeFaceAO(
            direction,
            tableCoordinate(x),
            tableCoordinate(y),
            tableCoordinate(z),
            prepared.table,
            prepared.materialOccluding,
          );
      const packedAoByte = packWorldQuadAo(ao);
      const flipDiagonal = worldQuadFlipDiagonal(face.tintIndex, packedAoByte);
      const plane = coordinate(face.planeAxis, x, y, z) + face.planeOffset;
      const u = coordinate(face.uAxis, x, y, z);
      const v = coordinate(face.vAxis, x, y, z);
      const key = faceKey(plane, paletteTypeId, face.directionIndex, ao, packedAoByte);
      if (key === null) {
        appendFaceRect(
          buckets,
          {
            direction,
            directionIndex: face.directionIndex,
            plane,
            bucket: face.bucket,
            tintIndex: face.tintIndex,
            atlasWord,
            packedAoByte,
            flipDiagonal,
            cells: [],
            minU: u,
            minV: v,
            maxU: u,
            maxV: v,
          },
          u,
          v,
          1,
          1,
        );
        continue;
      }
      let facePlaneEntry = planes.get(key);
      if (!facePlaneEntry) {
        facePlaneEntry = {
          direction,
          directionIndex: face.directionIndex,
          plane,
          bucket: face.bucket,
          tintIndex: face.tintIndex,
          atlasWord,
          packedAoByte,
          flipDiagonal,
          cells: [],
          minU: u,
          minV: v,
          maxU: u,
          maxV: v,
        };
        planes.set(key, facePlaneEntry);
      }
      facePlaneEntry.cells.push(v * face.dimensionWidth + u);
      facePlaneEntry.minU = Math.min(facePlaneEntry.minU, u);
      facePlaneEntry.minV = Math.min(facePlaneEntry.minV, v);
      facePlaneEntry.maxU = Math.max(facePlaneEntry.maxU, u);
      facePlaneEntry.maxV = Math.max(facePlaneEntry.maxV, v);
    }
  }

  for (const plane of planes.values()) appendMergedPlane(buckets, plane, opts.size);

  const worldQuads: WorldQuadPayload = {
    anchor: [prepared.cx, prepared.cy, prepared.cz],
    opaque: serializeWorldQuadBucket(buckets.opaque),
    cutout: serializeWorldQuadBucket(buckets.cutout),
    transparent: serializeWorldQuadBucket(buckets.transparent),
    water: serializeWorldQuadBucket(buckets.water),
    emissive: serializeWorldQuadBucket(buckets.emissive),
  };

  return {
    opaque: null,
    cutout: null,
    transparent: null,
    water: null,
    emissive: null,
    bounds: buildBounds(prepared),
    filteredBlockCount: prepared.filteredBlockCount,
    worldQuads,
  } as VoxelMeshPayload & { worldQuads: WorldQuadPayload };
}
