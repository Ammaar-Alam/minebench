import { getRenderKind } from "@/lib/blocks/registry";
import { getAtlasUv, hasAtlasKey } from "@/lib/blocks/atlas";
import { Face, getTextureKey } from "@/lib/blocks/textures";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";
import type {
  SerializedBuildBounds,
  TransferableVoxelBlocks,
  VoxelMeshPayload,
} from "@/lib/voxel/mesh";
import { appendQuad, makeBucket, serializeBucket, type MeshBucket } from "@/lib/voxel/meshBuckets";
import {
  computeVisibleFaceMask,
  DIRS,
  SpatialBlockTable,
  type CornerOffset,
  type Direction,
} from "@/lib/voxel/ambientOcclusion";
import type { VoxelMeshFacts } from "@/lib/voxel/meshFacts";

type BuildProgress = {
  processedBlocks: number;
  totalBlocks: number;
  stageLabel?: string;
};

type WorkerRequest =
  | {
      type: "build";
      blocks: TransferableVoxelBlocks;
      allowedBlockIds: string[];
      blockLimit?: number;
    }
  | {
      type: "mesh-facts";
      facts: VoxelMeshFacts;
      allowedBlockIds: string[];
    };

type WorkerResponse =
  | { type: "progress"; progress: BuildProgress }
  | { type: "complete"; payload: VoxelMeshPayload }
  | { type: "error"; message: string };

type PreparedMeshData = {
  allowed: Set<string>;
  table: SpatialBlockTable;
  materialOccluding: Uint8Array;
  typeNames: string[];
  blocks: TransferableVoxelBlocks;
  visibleFaceMasks: Uint8Array;
  nonWaterBlockIndices: Int32Array;
  nonWaterCount: number;
  waterBlockIndices: Int32Array;
  waterCount: number;
  filteredBlockCount: number;
  maxInputBlocks: number;
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

type FaceTint = readonly [number, number, number];
type FaceUv = readonly [number, number, number, number, number, number, number, number];

type PreResolvedFaceTable = {
  valid: Uint8Array;
  bucketIndex: Uint8Array;
  isEmissive: Uint8Array;
  tints: Array<FaceTint | null>;
  uvs: Array<FaceUv | null>;
};

type NeighborhoodCache = {
  table: SpatialBlockTable;
  materialOccluding: Uint8Array;
  x: number;
  y: number;
  z: number;
  knownMask: number;
  occludingMask: number;
};

const workerScope = (typeof self !== "undefined" ? self : globalThis) as unknown as typeof globalThis & {
  postMessage?: (message: WorkerResponse, transfer?: Transferable[]) => void;
  onmessage?: ((event: MessageEvent<WorkerRequest>) => void) | null;
};
const POSITION_BITS = 10;
const POSITION_MASK = (1 << POSITION_BITS) - 1;
const WATER_BLOCK_ID = "water";
const PROGRESS_EVERY = 4096;
const AO_FACTORS = [0.58, 0.72, 0.86, 1] as const;
const AMBIENT_OCCLUSION_BY_BYTE = Array.from({ length: 256 }, (_, packed) => [
  AO_FACTORS[packed & 0x03],
  AO_FACTORS[(packed >> 2) & 0x03],
  AO_FACTORS[(packed >> 4) & 0x03],
  AO_FACTORS[(packed >> 6) & 0x03],
] as const);

function packPlaneCell(u: number, v: number): number {
  return u | (v << POSITION_BITS);
}

function unpackPlaneCellU(value: number): number {
  return value & POSITION_MASK;
}

function unpackPlaneCellV(value: number): number {
  return value >> POSITION_BITS;
}

function srgbByteToLinear(byte: number): number {
  const s = Math.min(1, Math.max(0, byte / 255));
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function hexToLinearRgb(hex: number): [number, number, number] {
  return [
    srgbByteToLinear((hex >> 16) & 0xff),
    srgbByteToLinear((hex >> 8) & 0xff),
    srgbByteToLinear(hex & 0xff),
  ];
}

const TINT_LEAVES = hexToLinearRgb(0x48b518);
const TINT_GRASS = hexToLinearRgb(0x7fb238);
const TINT_WATER = hexToLinearRgb(0x3f76e4);
const TINT_WHITE: [number, number, number] = [1, 1, 1];

function faceTint(blockType: string, face: Face): FaceTint {
  if (blockType === "oak_leaves") return TINT_LEAVES;
  if (blockType === WATER_BLOCK_ID) return TINT_WATER;
  if (blockType === "grass_block" && face === "up") return TINT_GRASS;
  return TINT_WHITE;
}

function buildFaceTable(
  typeNames: string[],
  allowed: Set<string>,
): PreResolvedFaceTable {
  const numTypes = typeNames.length;
  const numFaces = numTypes * 6;
  const valid = new Uint8Array(numFaces);
  const bucketIndex = new Uint8Array(numFaces);
  const isEmissive = new Uint8Array(numFaces);
  const tints = new Array<FaceTint | null>(numFaces).fill(null);
  const uvs = new Array<FaceUv | null>(numFaces).fill(null);

  for (let typeId = 0; typeId < numTypes; typeId += 1) {
    const typeName = typeNames[typeId];
    if (!typeName || !allowed.has(typeName)) continue;

    const kind = getRenderKind(typeName) ?? "opaque";
    const bIndex =
      kind === "transparent" ? 2 : kind === "cutout" ? 1 : kind === "emissive" ? 3 : 0;
    const emissive = kind === "emissive" ? 1 : 0;

    for (let dIdx = 0; dIdx < 6; dIdx += 1) {
      const d = DIRS[dIdx];
      const texKey = getTextureKey(typeName, d.face);
      const faceIdx = typeId * 6 + dIdx;
      isEmissive[faceIdx] = emissive;
      if (!hasAtlasKey(texKey)) continue;

      const uv = getAtlasUv(texKey);
      const tint = faceTint(typeName, d.face);

      valid[faceIdx] = 1;
      bucketIndex[faceIdx] = bIndex;
      tints[faceIdx] = tint;
      uvs[faceIdx] = [uv.u0, uv.v0, uv.u0, uv.v1, uv.u1, uv.v1, uv.u1, uv.v0];
    }
  }

  return { valid, bucketIndex, isEmissive, tints, uvs };
}

function serializeBounds(prepared: PreparedMeshData): SerializedBuildBounds {
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
  const radius = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
  return { min, max, center, radius };
}

function postProgress(processedBlocks: number, totalBlocks: number, stageLabel: string) {
  if (typeof workerScope.postMessage !== "function") return;
  const message: WorkerResponse = {
    type: "progress",
    progress: {
      processedBlocks: Math.max(0, processedBlocks),
      totalBlocks: Math.max(1, totalBlocks),
      stageLabel,
    },
  };
  workerScope.postMessage(message);
}

function isOccludingInNeighborhood(
  cache: NeighborhoodCache,
  dx: number,
  dy: number,
  dz: number,
): boolean {
  const bit = 1 << ((dx + 1) * 9 + (dy + 1) * 3 + dz + 1);
  if ((cache.knownMask & bit) === 0) {
    const typeId = cache.table.get(cache.x + dx, cache.y + dy, cache.z + dz);
    cache.knownMask |= bit;
    if (typeId !== -1 && cache.materialOccluding[typeId] === 1) {
      cache.occludingMask |= bit;
    }
  }
  return (cache.occludingMask & bit) !== 0;
}

function cachedCornerFactor(
  corner: CornerOffset,
  direction: Direction,
  cache: NeighborhoodCache,
): number {
  const sideA = isOccludingInNeighborhood(
    cache,
    direction.dx + corner.sideA[0],
    direction.dy + corner.sideA[1],
    direction.dz + corner.sideA[2],
  );
  const sideB = isOccludingInNeighborhood(
    cache,
    direction.dx + corner.sideB[0],
    direction.dy + corner.sideB[1],
    direction.dz + corner.sideB[2],
  );
  if (sideA && sideB) return 0.58;
  const diagonal = isOccludingInNeighborhood(
    cache,
    direction.dx + corner.diag[0],
    direction.dy + corner.diag[1],
    direction.dz + corner.diag[2],
  );
  const level = 3 - ((sideA ? 1 : 0) + (sideB ? 1 : 0) + (diagonal ? 1 : 0));
  return 0.58 + (level / 3) * 0.42;
}

function computeFaceAOWithCache(
  direction: Direction,
  cache: NeighborhoodCache,
): readonly [number, number, number, number] {
  return [
    cachedCornerFactor(direction.corners[0], direction, cache),
    cachedCornerFactor(direction.corners[1], direction, cache),
    cachedCornerFactor(direction.corners[2], direction, cache),
    cachedCornerFactor(direction.corners[3], direction, cache),
  ];
}

function prepareMeshData(
  blocks: TransferableVoxelBlocks,
  allowedBlockIds: string[],
  blockLimit?: number,
): PreparedMeshData {
  const allowed = new Set(allowedBlockIds);
  const { positions, typeIds, typeNames } = blocks;

  const rawCount = typeof blocks.count === "number" ? blocks.count : typeIds.length;
  const inputLimit =
    typeof blockLimit === "number" && Number.isFinite(blockLimit)
      ? Math.max(0, Math.floor(blockLimit))
      : rawCount;
  const maxInputBlocks = Math.min(rawCount, inputLimit);

  const table = new SpatialBlockTable(maxInputBlocks);
  const materialOccluding = new Uint8Array(typeNames.length);

  for (let i = 0; i < typeNames.length; i += 1) {
    const name = typeNames[i];
    materialOccluding[i] = isVoxelOccluder(name) ? 1 : 0;
  }

  const visibleFaceMasks = new Uint8Array(maxInputBlocks);
  const nonWaterBlockIndices = new Int32Array(maxInputBlocks);
  const waterBlockIndices = new Int32Array(maxInputBlocks);
  let nonWaterCount = 0;
  let waterCount = 0;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < maxInputBlocks; i += 1) {
    const typeId = typeIds[i];
    const type = typeNames[typeId];
    if (!type || !allowed.has(type)) continue;
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    table.set(x, y, z, typeId);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, maxInputBlocks, "Indexing blocks");
    }
  }

  for (let i = 0; i < maxInputBlocks; i += 1) {
    const typeId = typeIds[i];
    const type = typeNames[typeId];
    if (!type || !allowed.has(type)) continue;
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const visibleFaceMask = computeVisibleFaceMask(x, y, z, typeId, table, materialOccluding);
    visibleFaceMasks[i] = visibleFaceMask;
    if (visibleFaceMask === 0) continue;

    if (type === WATER_BLOCK_ID) {
      waterBlockIndices[waterCount] = i;
      waterCount += 1;
    } else {
      nonWaterBlockIndices[nonWaterCount] = i;
      nonWaterCount += 1;
    }

    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, maxInputBlocks, "Filtering hidden blocks");
    }
  }

  if (!Number.isFinite(minX)) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }

  return {
    allowed,
    table,
    materialOccluding,
    typeNames,
    blocks,
    visibleFaceMasks,
    nonWaterBlockIndices,
    nonWaterCount,
    waterBlockIndices,
    waterCount,
    filteredBlockCount: nonWaterCount + waterCount,
    maxInputBlocks,
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

function prepareMeshDataFromFacts(
  facts: VoxelMeshFacts,
  allowedBlockIds: string[],
): PreparedMeshData {
  const allowed = new Set(allowedBlockIds);
  const blocks = facts.blocks;
  if (facts.visibilityMasks.length !== blocks.count) {
    throw new Error("Mesh facts visibility masks do not match block count");
  }

  const nonWaterBlockIndices = new Int32Array(blocks.count);
  const waterBlockIndices = new Int32Array(blocks.count);
  let nonWaterCount = 0;
  let waterCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < blocks.count; i += 1) {
    const type = blocks.typeNames[blocks.typeIds[i]];
    if (!type || !allowed.has(type)) continue;
    const x = blocks.positions[i * 3];
    const y = blocks.positions[i * 3 + 1];
    const z = blocks.positions[i * 3 + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    if (facts.visibilityMasks[i] !== 0) {
      if (type === WATER_BLOCK_ID) {
        waterBlockIndices[waterCount] = i;
        waterCount += 1;
      } else {
        nonWaterBlockIndices[nonWaterCount] = i;
        nonWaterCount += 1;
      }
    }
    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, Math.max(1, blocks.count), "Loading mesh facts");
    }
  }

  if (!Number.isFinite(minX)) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }

  return {
    allowed,
    table: new SpatialBlockTable(0),
    materialOccluding: new Uint8Array(0),
    typeNames: blocks.typeNames,
    blocks,
    visibleFaceMasks: facts.visibilityMasks,
    nonWaterBlockIndices,
    nonWaterCount,
    waterBlockIndices,
    waterCount,
    filteredBlockCount: nonWaterCount + waterCount,
    maxInputBlocks: blocks.count,
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

function appendStandardFaces(
  blockIdx: number,
  prepared: PreparedMeshData,
  faceTable: PreResolvedFaceTable,
  bucketList: [MeshBucket, MeshBucket, MeshBucket, MeshBucket],
  neighborhoodCache: NeighborhoodCache,
) {
  const { positions, typeIds } = prepared.blocks;
  const typeId = typeIds[blockIdx];
  const x = positions[blockIdx * 3];
  const y = positions[blockIdx * 3 + 1];
  const z = positions[blockIdx * 3 + 2];
  const bx = x - prepared.cx;
  const by = y - prepared.cy;
  const bz = z - prepared.cz;
  const visibleFaceMask = prepared.visibleFaceMasks[blockIdx];
  neighborhoodCache.x = x;
  neighborhoodCache.y = y;
  neighborhoodCache.z = z;
  neighborhoodCache.knownMask = 0;
  neighborhoodCache.occludingMask = 0;

  const baseFaceIdx = typeId * 6;

  for (let dIdx = 0; dIdx < 6; dIdx += 1) {
    if ((visibleFaceMask & (1 << dIdx)) === 0) continue;
    const d = DIRS[dIdx];
    const faceIdx = baseFaceIdx + dIdx;
    if (faceTable.valid[faceIdx] === 0) continue;

    const bucket = bucketList[faceTable.bucketIndex[faceIdx]];
    const tint = faceTable.tints[faceIdx]!;
    const uv = faceTable.uvs[faceIdx]!;
    const ao = faceTable.isEmissive[faceIdx] === 1
      ? undefined
      : computeFaceAOWithCache(d, neighborhoodCache);

    appendQuad(
      bucket,
      d.quad(bx, by, bz),
      d,
      tint,
      uv,
      ao,
    );
  }
}

function appendStandardFacesFromFacts(
  blockIdx: number,
  prepared: PreparedMeshData,
  faceTable: PreResolvedFaceTable,
  bucketList: [MeshBucket, MeshBucket, MeshBucket, MeshBucket],
  ambientOcclusion: Uint8Array,
  ambientOcclusionCursor: { value: number },
) {
  const { positions, typeIds } = prepared.blocks;
  const typeId = typeIds[blockIdx];
  const x = positions[blockIdx * 3];
  const y = positions[blockIdx * 3 + 1];
  const z = positions[blockIdx * 3 + 2];
  const bx = x - prepared.cx;
  const by = y - prepared.cy;
  const bz = z - prepared.cz;
  const visibleFaceMask = prepared.visibleFaceMasks[blockIdx];
  const baseFaceIdx = typeId * 6;

  for (let dIdx = 0; dIdx < 6; dIdx += 1) {
    if ((visibleFaceMask & (1 << dIdx)) === 0) continue;
    const faceIdx = baseFaceIdx + dIdx;
    let ao: readonly [number, number, number, number] | undefined;
    if (faceTable.isEmissive[faceIdx] === 0) {
      if (ambientOcclusionCursor.value >= ambientOcclusion.length) {
        throw new Error("Mesh facts ambient occlusion data is truncated");
      }
      ao = AMBIENT_OCCLUSION_BY_BYTE[ambientOcclusion[ambientOcclusionCursor.value]];
      ambientOcclusionCursor.value += 1;
    }
    if (faceTable.valid[faceIdx] === 0) continue;

    appendQuad(
      bucketList[faceTable.bucketIndex[faceIdx]],
      DIRS[dIdx].quad(bx, by, bz),
      DIRS[dIdx],
      faceTable.tints[faceIdx]!,
      faceTable.uvs[faceIdx]!,
      ao,
    );
  }
}

function getOrCreatePlane(
  planes: Map<string, { face: Face; plane: number; cells: Set<number> }>,
  face: Face,
  plane: number,
) {
  const key = `${face}:${plane}`;
  const existing = planes.get(key);
  if (existing) return existing;
  const created = { face, plane, cells: new Set<number>() };
  planes.set(key, created);
  return created;
}

function appendWaterRect(
  bucket: MeshBucket,
  face: Face,
  plane: number,
  u: number,
  v: number,
  width: number,
  height: number,
  prepared: PreparedMeshData,
) {
  const x0 = u;
  const x1 = u + width;
  const y0 = v;
  const y1 = v + height;
  let verts: [number, number, number][];
  let normal: Pick<Direction, "nx" | "ny" | "nz">;

  switch (face) {
    case "east":
      verts = [
        [plane - prepared.cx, x0 - prepared.cy, y0 - prepared.cz],
        [plane - prepared.cx, x1 - prepared.cy, y0 - prepared.cz],
        [plane - prepared.cx, x1 - prepared.cy, y1 - prepared.cz],
        [plane - prepared.cx, x0 - prepared.cy, y1 - prepared.cz],
      ];
      normal = { nx: 1, ny: 0, nz: 0 };
      break;
    case "west":
      verts = [
        [plane - prepared.cx, x0 - prepared.cy, y1 - prepared.cz],
        [plane - prepared.cx, x1 - prepared.cy, y1 - prepared.cz],
        [plane - prepared.cx, x1 - prepared.cy, y0 - prepared.cz],
        [plane - prepared.cx, x0 - prepared.cy, y0 - prepared.cz],
      ];
      normal = { nx: -1, ny: 0, nz: 0 };
      break;
    case "north":
      verts = [
        [x0 - prepared.cx, y0 - prepared.cy, plane - prepared.cz],
        [x0 - prepared.cx, y1 - prepared.cy, plane - prepared.cz],
        [x1 - prepared.cx, y1 - prepared.cy, plane - prepared.cz],
        [x1 - prepared.cx, y0 - prepared.cy, plane - prepared.cz],
      ];
      normal = { nx: 0, ny: 0, nz: -1 };
      break;
    case "south":
      verts = [
        [x1 - prepared.cx, y0 - prepared.cy, plane - prepared.cz],
        [x1 - prepared.cx, y1 - prepared.cy, plane - prepared.cz],
        [x0 - prepared.cx, y1 - prepared.cy, plane - prepared.cz],
        [x0 - prepared.cx, y0 - prepared.cy, plane - prepared.cz],
      ];
      normal = { nx: 0, ny: 0, nz: 1 };
      break;
    case "up":
      verts = [
        [x0 - prepared.cx, plane - prepared.cy, y1 - prepared.cz],
        [x1 - prepared.cx, plane - prepared.cy, y1 - prepared.cz],
        [x1 - prepared.cx, plane - prepared.cy, y0 - prepared.cz],
        [x0 - prepared.cx, plane - prepared.cy, y0 - prepared.cz],
      ];
      normal = { nx: 0, ny: 1, nz: 0 };
      break;
    case "down":
      verts = [
        [x0 - prepared.cx, plane - prepared.cy, y0 - prepared.cz],
        [x1 - prepared.cx, plane - prepared.cy, y0 - prepared.cz],
        [x1 - prepared.cx, plane - prepared.cy, y1 - prepared.cz],
        [x0 - prepared.cx, plane - prepared.cy, y1 - prepared.cz],
      ];
      normal = { nx: 0, ny: -1, nz: 0 };
      break;
  }

  appendQuad(
    bucket,
    verts,
    normal,
    TINT_WATER,
    [0, 0, 0, height, width, height, width, 0],
  );
}

function appendMergedPlaneFaces(
  bucket: MeshBucket,
  face: Face,
  plane: number,
  cells: Set<number>,
  prepared: PreparedMeshData,
) {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;

  for (const cell of cells) {
    const u = unpackPlaneCellU(cell);
    const v = unpackPlaneCellV(cell);
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  }

  if (!Number.isFinite(minU) || !Number.isFinite(minV)) return;

  const width = maxU - minU + 1;
  const height = maxV - minV + 1;
  const mask = new Uint8Array(width * height);

  for (const cell of cells) {
    const u = unpackPlaneCellU(cell) - minU;
    const v = unpackPlaneCellV(cell) - minV;
    mask[v * width + u] = 1;
  }

  for (let v = 0; v < height; v += 1) {
    for (let u = 0; u < width; u += 1) {
      const idx = v * width + u;
      if (mask[idx] === 0) continue;

      let rectWidth = 1;
      while (u + rectWidth < width && mask[v * width + u + rectWidth] === 1) {
        rectWidth += 1;
      }

      let rectHeight = 1;
      outer: while (v + rectHeight < height) {
        for (let x = 0; x < rectWidth; x += 1) {
          if (mask[(v + rectHeight) * width + u + x] === 0) break outer;
        }
        rectHeight += 1;
      }

      for (let dy = 0; dy < rectHeight; dy += 1) {
        mask.fill(0, (v + dy) * width + u, (v + dy) * width + u + rectWidth);
      }

      appendWaterRect(bucket, face, plane, minU + u, minV + v, rectWidth, rectHeight, prepared);
    }
  }
}

function buildWaterSurfaceBucket(prepared: PreparedMeshData): MeshBucket {
  const bucket = makeBucket({ repeatingUvs: true });
  const planes = new Map<string, { face: Face; plane: number; cells: Set<number> }>();
  if (!prepared.allowed.has(WATER_BLOCK_ID) || prepared.waterCount === 0) return bucket;
  const { positions } = prepared.blocks;

  for (let i = 0; i < prepared.waterCount; i += 1) {
    const blockIdx = prepared.waterBlockIndices[i];
    const x = positions[blockIdx * 3];
    const y = positions[blockIdx * 3 + 1];
    const z = positions[blockIdx * 3 + 2];
    const visibleFaceMask = prepared.visibleFaceMasks[blockIdx];

    for (let dIdx = 0; dIdx < 6; dIdx += 1) {
      if ((visibleFaceMask & (1 << dIdx)) === 0) continue;
      const d = DIRS[dIdx];
      switch (d.face) {
        case "east":
          getOrCreatePlane(planes, d.face, x + 1).cells.add(packPlaneCell(y, z));
          break;
        case "west":
          getOrCreatePlane(planes, d.face, x).cells.add(packPlaneCell(y, z));
          break;
        case "north":
          getOrCreatePlane(planes, d.face, z).cells.add(packPlaneCell(x, y));
          break;
        case "south":
          getOrCreatePlane(planes, d.face, z + 1).cells.add(packPlaneCell(x, y));
          break;
        case "up":
          getOrCreatePlane(planes, d.face, y + 1).cells.add(packPlaneCell(x, z));
          break;
        case "down":
          getOrCreatePlane(planes, d.face, y).cells.add(packPlaneCell(x, z));
          break;
      }
    }

    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, Math.max(1, prepared.waterCount), "Meshing water");
    }
  }

  let processedPlanes = 0;
  const totalPlanes = Math.max(1, planes.size);
  for (const plane of planes.values()) {
    appendMergedPlaneFaces(bucket, plane.face, plane.plane, plane.cells, prepared);
    processedPlanes += 1;
    if ((processedPlanes & 31) === 0) {
      postProgress(processedPlanes, totalPlanes, "Meshing water");
    }
  }

  return bucket;
}

export function buildMeshPayload(
  blocks: TransferableVoxelBlocks,
  allowedBlockIds: string[],
  blockLimit?: number,
): VoxelMeshPayload {
  const prepared = prepareMeshData(blocks, allowedBlockIds, blockLimit);
  const faceTable = buildFaceTable(prepared.typeNames, prepared.allowed);
  const opaque = makeBucket();
  const cutout = makeBucket();
  const transparent = makeBucket();
  const emissive = makeBucket();
  const bucketList: [MeshBucket, MeshBucket, MeshBucket, MeshBucket] = [
    opaque,
    cutout,
    transparent,
    emissive,
  ];
  const neighborhoodCache: NeighborhoodCache = {
    table: prepared.table,
    materialOccluding: prepared.materialOccluding,
    x: 0,
    y: 0,
    z: 0,
    knownMask: 0,
    occludingMask: 0,
  };

  for (let i = 0; i < prepared.nonWaterCount; i += 1) {
    const blockIdx = prepared.nonWaterBlockIndices[i];
    appendStandardFaces(blockIdx, prepared, faceTable, bucketList, neighborhoodCache);
    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, Math.max(1, prepared.nonWaterCount), "Meshing blocks");
    }
  }

  const water = buildWaterSurfaceBucket(prepared);
  postProgress(prepared.filteredBlockCount, Math.max(1, prepared.filteredBlockCount), "Finalizing geometry");

  return {
    opaque: serializeBucket(opaque),
    cutout: serializeBucket(cutout),
    transparent: serializeBucket(transparent),
    water: serializeBucket(water),
    emissive: serializeBucket(emissive),
    bounds: serializeBounds(prepared),
    filteredBlockCount: prepared.filteredBlockCount,
  };
}

export function buildMeshPayloadFromFacts(
  facts: VoxelMeshFacts,
  allowedBlockIds: string[],
): VoxelMeshPayload {
  const allowed = new Set(allowedBlockIds);
  if (facts.blocks.typeNames.some((type) => !allowed.has(type))) {
    return buildMeshPayload(facts.blocks, allowedBlockIds);
  }
  const prepared = prepareMeshDataFromFacts(facts, allowedBlockIds);
  const faceTable = buildFaceTable(prepared.typeNames, prepared.allowed);
  const opaque = makeBucket();
  const cutout = makeBucket();
  const transparent = makeBucket();
  const emissive = makeBucket();
  const bucketList: [MeshBucket, MeshBucket, MeshBucket, MeshBucket] = [
    opaque,
    cutout,
    transparent,
    emissive,
  ];
  const ambientOcclusionCursor = { value: 0 };

  for (let i = 0; i < prepared.nonWaterCount; i += 1) {
    appendStandardFacesFromFacts(
      prepared.nonWaterBlockIndices[i],
      prepared,
      faceTable,
      bucketList,
      facts.ambientOcclusion,
      ambientOcclusionCursor,
    );
    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, Math.max(1, prepared.nonWaterCount), "Expanding mesh facts");
    }
  }
  if (ambientOcclusionCursor.value !== facts.ambientOcclusion.length) {
    throw new Error("Mesh facts ambient occlusion data has trailing bytes");
  }

  const water = buildWaterSurfaceBucket(prepared);
  postProgress(prepared.filteredBlockCount, Math.max(1, prepared.filteredBlockCount), "Finalizing geometry");
  return {
    opaque: serializeBucket(opaque),
    cutout: serializeBucket(cutout),
    transparent: serializeBucket(transparent),
    water: serializeBucket(water),
    emissive: serializeBucket(emissive),
    bounds: serializeBounds(prepared),
    filteredBlockCount: prepared.filteredBlockCount,
  };
}

function collectTransferables(payload: VoxelMeshPayload): Transferable[] {
  const transferables: Transferable[] = [];
  for (const bucket of [
    payload.opaque,
    payload.cutout,
    payload.transparent,
    payload.water,
    payload.emissive,
  ]) {
    if (!bucket) continue;
    transferables.push(
      bucket.positions.buffer,
      bucket.normals.buffer,
      bucket.uvs.buffer,
      bucket.colors.buffer,
      bucket.indices.buffer,
    );
  }
  return transferables;
}

if (typeof self !== "undefined") {
  workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const message = event.data;
    if (!message) return;

    try {
      const payload = message.type === "mesh-facts"
        ? buildMeshPayloadFromFacts(message.facts, message.allowedBlockIds)
        : buildMeshPayload(message.blocks, message.allowedBlockIds, message.blockLimit);
      const response: WorkerResponse = { type: "complete", payload };
      workerScope.postMessage?.(response, collectTransferables(payload));
    } catch (err) {
      const response: WorkerResponse = {
        type: "error",
        message: err instanceof Error ? err.message : "Mesh worker failed",
      };
      workerScope.postMessage?.(response);
    }
  };
}
