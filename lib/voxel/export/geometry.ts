import type { BlockDefinition } from "@/lib/blocks/palettes";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";
import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";
import { getVoxelExportMaterial, type VoxelExportMaterial } from "@/lib/voxel/export/materials";

export type VoxelExportBounds = {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
};

export type VoxelExportGeometryBucket = {
  blockId: string;
  material: VoxelExportMaterial;
  positions: number[];
  normals: number[];
  indices: number[];
  faceCount: number;
};

export type VoxelExportGeometry = {
  buckets: VoxelExportGeometryBucket[];
  bounds: VoxelExportBounds;
  inputBlockCount: number;
  exportedBlockCount: number;
  visibleFaceCount: number;
  triangleCount: number;
  materialCount: number;
};

type FaceName = "east" | "west" | "north" | "south" | "up" | "down";

type Direction = {
  face: FaceName;
  dx: number;
  dy: number;
  dz: number;
};

type PlaneCells = {
  blockId: string;
  face: FaceName;
  plane: number;
  cells: Set<number>;
};

const DIRECTIONS: Direction[] = [
  { face: "east", dx: 1, dy: 0, dz: 0 },
  { face: "west", dx: -1, dy: 0, dz: 0 },
  { face: "north", dx: 0, dy: 0, dz: -1 },
  { face: "south", dx: 0, dy: 0, dz: 1 },
  { face: "up", dx: 0, dy: 1, dz: 0 },
  { face: "down", dx: 0, dy: -1, dz: 0 },
];

const POSITION_BITS = 10;
const POSITION_MASK = (1 << POSITION_BITS) - 1;

function encodePosition(x: number, y: number, z: number): number {
  return x | (y << POSITION_BITS) | (z << (POSITION_BITS * 2));
}

function packPlaneCell(u: number, v: number): number {
  return u | (v << POSITION_BITS);
}

function unpackPlaneCellU(value: number): number {
  return value & POSITION_MASK;
}

function unpackPlaneCellV(value: number): number {
  return value >> POSITION_BITS;
}

function makeBucket(blockId: string): VoxelExportGeometryBucket {
  return {
    blockId,
    material: getVoxelExportMaterial(blockId),
    positions: [],
    normals: [],
    indices: [],
    faceCount: 0,
  };
}

function appendQuad(
  bucket: VoxelExportGeometryBucket,
  verts: [number, number, number][],
  normal: [number, number, number],
) {
  const baseIndex = bucket.positions.length / 3;
  for (const [x, y, z] of verts) {
    bucket.positions.push(x, y, z);
    bucket.normals.push(normal[0], normal[1], normal[2]);
  }
  bucket.indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
  bucket.faceCount += 1;
}

function appendRect(
  bucket: VoxelExportGeometryBucket,
  face: FaceName,
  plane: number,
  u: number,
  v: number,
  width: number,
  height: number,
  center: [number, number, number],
) {
  const [cx, cy, cz] = center;
  const u0 = u;
  const u1 = u + width;
  const v0 = v;
  const v1 = v + height;

  switch (face) {
    case "east":
      appendQuad(
        bucket,
        [
          [plane - cx, u0 - cy, v0 - cz],
          [plane - cx, u1 - cy, v0 - cz],
          [plane - cx, u1 - cy, v1 - cz],
          [plane - cx, u0 - cy, v1 - cz],
        ],
        [1, 0, 0],
      );
      return;
    case "west":
      appendQuad(
        bucket,
        [
          [plane - cx, u0 - cy, v1 - cz],
          [plane - cx, u1 - cy, v1 - cz],
          [plane - cx, u1 - cy, v0 - cz],
          [plane - cx, u0 - cy, v0 - cz],
        ],
        [-1, 0, 0],
      );
      return;
    case "north":
      appendQuad(
        bucket,
        [
          [u0 - cx, v0 - cy, plane - cz],
          [u0 - cx, v1 - cy, plane - cz],
          [u1 - cx, v1 - cy, plane - cz],
          [u1 - cx, v0 - cy, plane - cz],
        ],
        [0, 0, -1],
      );
      return;
    case "south":
      appendQuad(
        bucket,
        [
          [u1 - cx, v0 - cy, plane - cz],
          [u1 - cx, v1 - cy, plane - cz],
          [u0 - cx, v1 - cy, plane - cz],
          [u0 - cx, v0 - cy, plane - cz],
        ],
        [0, 0, 1],
      );
      return;
    case "up":
      appendQuad(
        bucket,
        [
          [u0 - cx, plane - cy, v1 - cz],
          [u1 - cx, plane - cy, v1 - cz],
          [u1 - cx, plane - cy, v0 - cz],
          [u0 - cx, plane - cy, v0 - cz],
        ],
        [0, 1, 0],
      );
      return;
    case "down":
      appendQuad(
        bucket,
        [
          [u0 - cx, plane - cy, v0 - cz],
          [u1 - cx, plane - cy, v0 - cz],
          [u1 - cx, plane - cy, v1 - cz],
          [u0 - cx, plane - cy, v1 - cz],
        ],
        [0, -1, 0],
      );
      return;
  }
}

function getPlaneCell(block: VoxelBlock, face: FaceName): { plane: number; u: number; v: number } {
  switch (face) {
    case "east":
      return { plane: block.x + 1, u: block.y, v: block.z };
    case "west":
      return { plane: block.x, u: block.y, v: block.z };
    case "north":
      return { plane: block.z, u: block.x, v: block.y };
    case "south":
      return { plane: block.z + 1, u: block.x, v: block.y };
    case "up":
      return { plane: block.y + 1, u: block.x, v: block.z };
    case "down":
      return { plane: block.y, u: block.x, v: block.z };
  }
}

function getOrCreatePlane(planes: Map<string, PlaneCells>, blockId: string, face: FaceName, plane: number) {
  const key = `${blockId}:${face}:${plane}`;
  const existing = planes.get(key);
  if (existing) return existing;
  const created: PlaneCells = { blockId, face, plane, cells: new Set<number>() };
  planes.set(key, created);
  return created;
}

function appendMergedPlane(
  bucket: VoxelExportGeometryBucket,
  plane: PlaneCells,
  center: [number, number, number],
) {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;

  for (const cell of plane.cells) {
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

  for (const cell of plane.cells) {
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
        for (let dx = 0; dx < rectWidth; dx += 1) {
          if (mask[(v + rectHeight) * width + u + dx] === 0) break outer;
        }
        rectHeight += 1;
      }

      for (let dy = 0; dy < rectHeight; dy += 1) {
        mask.fill(0, (v + dy) * width + u, (v + dy) * width + u + rectWidth);
      }

      appendRect(bucket, plane.face, plane.plane, minU + u, minV + v, rectWidth, rectHeight, center);
    }
  }
}

function shouldEmitFace(blockType: string, neighborType: string | undefined): boolean {
  if (!neighborType) return true;
  if (neighborType === blockType) return false;
  if (isVoxelOccluder(neighborType)) return false;
  return true;
}

export function buildVoxelExportGeometry(
  build: VoxelBuild,
  palette: BlockDefinition[],
): VoxelExportGeometry {
  const allowed = new Set(palette.map((block) => block.id));
  const blocksByPos = new Map<number, VoxelBlock>();
  const positionToType = new Map<number, string>();

  for (const block of build.blocks) {
    if (!allowed.has(block.type)) continue;
    const key = encodePosition(block.x, block.y, block.z);
    blocksByPos.set(key, block);
    positionToType.set(key, block.type);
  }

  const blocks = Array.from(blocksByPos.values());
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const block of blocks) {
    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
    minZ = Math.min(minZ, block.z);
    maxX = Math.max(maxX, block.x);
    maxY = Math.max(maxY, block.y);
    maxZ = Math.max(maxZ, block.z);
  }

  if (!Number.isFinite(minX)) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }

  const bounds: VoxelExportBounds = {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
    center: [(minX + maxX + 1) / 2, minY, (minZ + maxZ + 1) / 2],
  };

  const planes = new Map<string, PlaneCells>();
  let exportedBlockCount = 0;

  for (const block of blocks) {
    let emittedAny = false;
    for (const direction of DIRECTIONS) {
      const neighborType = positionToType.get(
        encodePosition(block.x + direction.dx, block.y + direction.dy, block.z + direction.dz),
      );
      if (!shouldEmitFace(block.type, neighborType)) continue;
      const cell = getPlaneCell(block, direction.face);
      getOrCreatePlane(planes, block.type, direction.face, cell.plane).cells.add(
        packPlaneCell(cell.u, cell.v),
      );
      emittedAny = true;
    }
    if (emittedAny) exportedBlockCount += 1;
  }

  const bucketMap = new Map<string, VoxelExportGeometryBucket>();
  const planesSorted = Array.from(planes.values()).sort((a, b) => {
    const materialOrder = a.blockId.localeCompare(b.blockId);
    if (materialOrder !== 0) return materialOrder;
    const faceOrder = a.face.localeCompare(b.face);
    if (faceOrder !== 0) return faceOrder;
    return a.plane - b.plane;
  });

  for (const plane of planesSorted) {
    let bucket = bucketMap.get(plane.blockId);
    if (!bucket) {
      bucket = makeBucket(plane.blockId);
      bucketMap.set(plane.blockId, bucket);
    }
    appendMergedPlane(bucket, plane, bounds.center);
  }

  const buckets = Array.from(bucketMap.values()).filter((bucket) => bucket.indices.length > 0);
  const visibleFaceCount = buckets.reduce((sum, bucket) => sum + bucket.faceCount, 0);

  return {
    buckets,
    bounds,
    inputBlockCount: build.blocks.length,
    exportedBlockCount,
    visibleFaceCount,
    triangleCount: visibleFaceCount * 2,
    materialCount: buckets.length,
  };
}
