import { getRenderKind } from "@/lib/blocks/registry";
import { getAtlasUv, hasAtlasKey } from "@/lib/blocks/atlas";
import { Face, getTextureKey } from "@/lib/blocks/textures";
import { canVoxelBlockEmitAnyFace, isVoxelOccluder } from "@/lib/voxel/renderVisibility";
import type { VoxelBuild } from "@/lib/voxel/types";
import type { SerializedBuildBounds, SerializedMeshBucket, VoxelMeshPayload } from "@/lib/voxel/mesh";

type BuildProgress = {
  processedBlocks: number;
  totalBlocks: number;
  stageLabel?: string;
};

type WorkerRequest = {
  type: "build";
  build: VoxelBuild;
  allowedBlockIds: string[];
  blockLimit?: number;
};

type WorkerResponse =
  | { type: "progress"; progress: BuildProgress }
  | { type: "complete"; payload: VoxelMeshPayload }
  | { type: "error"; message: string };

type MeshBucket = {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
};

type PreparedMeshData = {
  allowed: Set<string>;
  blocksByPos: Map<number, string>;
  nonWaterBlocks: VoxelBuild["blocks"];
  waterBlocks: VoxelBuild["blocks"];
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

type Direction = {
  face: Face;
  dx: number;
  dy: number;
  dz: number;
  nx: number;
  ny: number;
  nz: number;
  quad: (x: number, y: number, z: number) => [number, number, number][];
};

const workerScope = self as typeof globalThis & {
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};
const POSITION_BITS = 10;
const POSITION_MASK = (1 << POSITION_BITS) - 1;
const WATER_BLOCK_ID = "water";
const PROGRESS_EVERY = 4096;

const DIRS: Direction[] = [
  {
    face: "east",
    dx: 1,
    dy: 0,
    dz: 0,
    nx: 1,
    ny: 0,
    nz: 0,
    quad: (x, y, z) => [
      [x + 1, y, z],
      [x + 1, y + 1, z],
      [x + 1, y + 1, z + 1],
      [x + 1, y, z + 1],
    ],
  },
  {
    face: "west",
    dx: -1,
    dy: 0,
    dz: 0,
    nx: -1,
    ny: 0,
    nz: 0,
    quad: (x, y, z) => [
      [x, y, z + 1],
      [x, y + 1, z + 1],
      [x, y + 1, z],
      [x, y, z],
    ],
  },
  {
    face: "north",
    dx: 0,
    dy: 0,
    dz: -1,
    nx: 0,
    ny: 0,
    nz: -1,
    quad: (x, y, z) => [
      [x, y, z],
      [x, y + 1, z],
      [x + 1, y + 1, z],
      [x + 1, y, z],
    ],
  },
  {
    face: "south",
    dx: 0,
    dy: 0,
    dz: 1,
    nx: 0,
    ny: 0,
    nz: 1,
    quad: (x, y, z) => [
      [x + 1, y, z + 1],
      [x + 1, y + 1, z + 1],
      [x, y + 1, z + 1],
      [x, y, z + 1],
    ],
  },
  {
    face: "up",
    dx: 0,
    dy: 1,
    dz: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    quad: (x, y, z) => [
      [x, y + 1, z + 1],
      [x + 1, y + 1, z + 1],
      [x + 1, y + 1, z],
      [x, y + 1, z],
    ],
  },
  {
    face: "down",
    dx: 0,
    dy: -1,
    dz: 0,
    nx: 0,
    ny: -1,
    nz: 0,
    quad: (x, y, z) => [
      [x, y, z],
      [x + 1, y, z],
      [x + 1, y, z + 1],
      [x, y, z + 1],
    ],
  },
];

function makeBucket(): MeshBucket {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] };
}

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

function faceTint(blockType: string, face: Face): [number, number, number] {
  if (blockType === "oak_leaves") return TINT_LEAVES;
  if (blockType === WATER_BLOCK_ID) return TINT_WATER;
  if (blockType === "grass_block" && face === "up") return TINT_GRASS;
  return TINT_WHITE;
}

function bucketFor(
  blockType: string,
  buckets: {
    opaque: MeshBucket;
    cutout: MeshBucket;
    transparent: MeshBucket;
    emissive: MeshBucket;
  },
): MeshBucket {
  const kind = getRenderKind(blockType) ?? "opaque";
  if (kind === "transparent") return buckets.transparent;
  if (kind === "cutout") return buckets.cutout;
  if (kind === "emissive") return buckets.emissive;
  return buckets.opaque;
}

function appendQuad(
  bucket: MeshBucket,
  verts: [number, number, number][],
  normal: Pick<Direction, "nx" | "ny" | "nz">,
  tint: [number, number, number],
  uv: [number, number, number, number, number, number, number, number],
) {
  const baseIndex = bucket.positions.length / 3;
  for (const [vx, vy, vz] of verts) {
    bucket.positions.push(vx, vy, vz);
    bucket.normals.push(normal.nx, normal.ny, normal.nz);
    bucket.colors.push(tint[0], tint[1], tint[2]);
  }

  bucket.uvs.push(...uv);
  bucket.indices.push(
    baseIndex,
    baseIndex + 1,
    baseIndex + 2,
    baseIndex,
    baseIndex + 2,
    baseIndex + 3,
  );
}

function serializeBucket(bucket: MeshBucket): SerializedMeshBucket | null {
  if (bucket.indices.length === 0) return null;
  return {
    positions: Float32Array.from(bucket.positions),
    normals: Float32Array.from(bucket.normals),
    uvs: Float32Array.from(bucket.uvs),
    colors: Float32Array.from(bucket.colors),
    indices: Uint32Array.from(bucket.indices),
  };
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

function prepareMeshData(
  build: VoxelBuild,
  allowedBlockIds: string[],
  blockLimit?: number,
): PreparedMeshData {
  const allowed = new Set(allowedBlockIds);
  const nonWaterBlocks: VoxelBuild["blocks"] = [];
  const waterBlocks: VoxelBuild["blocks"] = [];
  const blocksByPos = new Map<number, string>();

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const inputLimit =
    typeof blockLimit === "number" && Number.isFinite(blockLimit)
      ? Math.max(0, Math.floor(blockLimit))
      : build.blocks.length;
  const maxInputBlocks = Math.min(build.blocks.length, inputLimit);

  for (let i = 0; i < maxInputBlocks; i += 1) {
    const b = build.blocks[i];
    if (!b || !allowed.has(b.type)) continue;
    blocksByPos.set(encodePosition(b.x, b.y, b.z), b.type);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    minZ = Math.min(minZ, b.z);
    maxX = Math.max(maxX, b.x);
    maxY = Math.max(maxY, b.y);
    maxZ = Math.max(maxZ, b.z);
    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, maxInputBlocks, "Indexing blocks");
    }
  }

  for (let i = 0; i < maxInputBlocks; i += 1) {
    const b = build.blocks[i];
    if (!b || !allowed.has(b.type)) continue;
    if (b.type === WATER_BLOCK_ID) {
      if (!canVoxelBlockEmitAnyFace(b, blocksByPos)) continue;
      waterBlocks.push(b);
      continue;
    }
    if (!canVoxelBlockEmitAnyFace(b, blocksByPos)) continue;
    nonWaterBlocks.push(b);
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
    blocksByPos,
    nonWaterBlocks,
    waterBlocks,
    filteredBlockCount: nonWaterBlocks.length + waterBlocks.length,
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

function appendStandardFaces(
  block: VoxelBuild["blocks"][number],
  prepared: PreparedMeshData,
  buckets: {
    opaque: MeshBucket;
    cutout: MeshBucket;
    transparent: MeshBucket;
    emissive: MeshBucket;
  },
) {
  const bx = block.x - prepared.cx;
  const by = block.y - prepared.cy;
  const bz = block.z - prepared.cz;

  for (const d of DIRS) {
    const neighborType = prepared.blocksByPos.get(
      encodePosition(block.x + d.dx, block.y + d.dy, block.z + d.dz),
    );
    if (neighborType) {
      if (neighborType === block.type) continue;
      if (isVoxelOccluder(neighborType)) continue;
    }

    const texKey = getTextureKey(block.type, d.face);
    if (!hasAtlasKey(texKey)) continue;
    const uv = getAtlasUv(texKey);
    const bucket = bucketFor(block.type, buckets);
    appendQuad(
      bucket,
      d.quad(bx, by, bz),
      d,
      faceTint(block.type, d.face),
      [uv.u0, uv.v0, uv.u0, uv.v1, uv.u1, uv.v1, uv.u1, uv.v0],
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
  const bucket = makeBucket();
  const planes = new Map<string, { face: Face; plane: number; cells: Set<number> }>();
  if (!prepared.allowed.has(WATER_BLOCK_ID) || prepared.waterBlocks.length === 0) return bucket;

  for (let i = 0; i < prepared.waterBlocks.length; i += 1) {
    const block = prepared.waterBlocks[i];
    if (!block) continue;

    for (const d of DIRS) {
      const neighborType = prepared.blocksByPos.get(
        encodePosition(block.x + d.dx, block.y + d.dy, block.z + d.dz),
      );
      if (neighborType) {
        if (neighborType === WATER_BLOCK_ID) continue;
        if (isVoxelOccluder(neighborType)) continue;
      }

      switch (d.face) {
        case "east":
          getOrCreatePlane(planes, d.face, block.x + 1).cells.add(packPlaneCell(block.y, block.z));
          break;
        case "west":
          getOrCreatePlane(planes, d.face, block.x).cells.add(packPlaneCell(block.y, block.z));
          break;
        case "north":
          getOrCreatePlane(planes, d.face, block.z).cells.add(packPlaneCell(block.x, block.y));
          break;
        case "south":
          getOrCreatePlane(planes, d.face, block.z + 1).cells.add(packPlaneCell(block.x, block.y));
          break;
        case "up":
          getOrCreatePlane(planes, d.face, block.y + 1).cells.add(packPlaneCell(block.x, block.z));
          break;
        case "down":
          getOrCreatePlane(planes, d.face, block.y).cells.add(packPlaneCell(block.x, block.z));
          break;
      }
    }

    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, Math.max(1, prepared.waterBlocks.length), "Meshing water");
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

function buildMeshPayload(build: VoxelBuild, allowedBlockIds: string[], blockLimit?: number): VoxelMeshPayload {
  const prepared = prepareMeshData(build, allowedBlockIds, blockLimit);
  const opaque = makeBucket();
  const cutout = makeBucket();
  const transparent = makeBucket();
  const emissive = makeBucket();

  for (let i = 0; i < prepared.nonWaterBlocks.length; i += 1) {
    const block = prepared.nonWaterBlocks[i];
    appendStandardFaces(block, prepared, { opaque, cutout, transparent, emissive });
    if ((i & (PROGRESS_EVERY - 1)) === 0) {
      postProgress(i, Math.max(1, prepared.nonWaterBlocks.length), "Meshing blocks");
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

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== "build") return;

  try {
    const payload = buildMeshPayload(message.build, message.allowedBlockIds, message.blockLimit);
    const response: WorkerResponse = { type: "complete", payload };
    workerScope.postMessage(response, collectTransferables(payload));
  } catch (err) {
    const response: WorkerResponse = {
      type: "error",
      message: err instanceof Error ? err.message : "Mesh worker failed",
    };
    workerScope.postMessage(response);
  }
};
