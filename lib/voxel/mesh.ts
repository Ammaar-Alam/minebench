import * as THREE from "three";
import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getRenderKind } from "@/lib/blocks/registry";
import { getAtlasUv, hasAtlasKey } from "@/lib/blocks/atlas";
import { Face, getTextureKey } from "@/lib/blocks/textures";
import type { VoxelBuild } from "@/lib/voxel/types";
import { getCachedMeshPayload, setCachedMeshPayload } from "@/lib/voxel/meshPayloadCache";

type BuildProgress = {
  processedBlocks: number;
  totalBlocks: number;
  stageLabel?: string;
};

type CreateVoxelGroupAsyncOpts = {
  signal?: AbortSignal;
  onProgress?: (progress: BuildProgress) => void;
  // Yield to the main thread when we've spent about this many ms in a tight loop.
  yieldAfterMs?: number;
  // When set, only process the first N input blocks. Useful for progressive streaming without copying arrays.
  blockLimit?: number;
  // Stable checksum-keyed cache identifier for persistent browser-side mesh payload reuse.
  cacheKey?: string | null;
};

export type SerializedMeshBucket = {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
};

export type SerializedBuildBounds = {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  radius: number;
};

export type VoxelMeshPayload = {
  opaque: SerializedMeshBucket | null;
  cutout: SerializedMeshBucket | null;
  transparent: SerializedMeshBucket | null;
  water: SerializedMeshBucket | null;
  emissive: SerializedMeshBucket | null;
  bounds: SerializedBuildBounds;
  filteredBlockCount: number;
};

type MeshBucket = {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
};

function makeBucket(): MeshBucket {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] };
}

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

function buildGeometry(
  bucket: MeshBucket,
  bounds?: { box: THREE.Box3; center: THREE.Vector3; radius: number },
): THREE.BufferGeometry | null {
  if (bucket.indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(bucket.positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(bucket.normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(bucket.uvs, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(bucket.colors, 3));
  geo.setIndex(bucket.indices);
  if (bounds) {
    geo.boundingBox = bounds.box.clone();
    geo.boundingSphere = new THREE.Sphere(bounds.center.clone(), bounds.radius);
  } else {
    geo.computeBoundingSphere();
  }
  return geo;
}

function buildGeometryFromSerialized(
  bucket: SerializedMeshBucket | null,
  bounds: { box: THREE.Box3; center: THREE.Vector3; radius: number },
): THREE.BufferGeometry | null {
  if (!bucket || bucket.indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(bucket.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(bucket.normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(bucket.uvs, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(bucket.colors, 3));
  geo.setIndex(new THREE.BufferAttribute(bucket.indices, 1));
  geo.boundingBox = bounds.box.clone();
  geo.boundingSphere = new THREE.Sphere(bounds.center.clone(), bounds.radius);
  return geo;
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    }
  });
}

function nowMs(): number {
  // `performance.now()` is higher resolution in the browser; fall back for non-browser contexts.
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

async function yieldToMainThread(): Promise<void> {
  const schedulerApi = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof schedulerApi?.yield === "function") {
    await schedulerApi.yield();
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal) return;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

export type VoxelGroup = {
  group: THREE.Group;
  dispose: () => void;
  bounds: { box: THREE.Box3; center: THREE.Vector3; radius: number };
  stats: { blockCount: number };
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

const POSITION_BITS = 10;
const POSITION_MASK = (1 << POSITION_BITS) - 1;
const WATER_BLOCK_ID = "water";

function encodePosition(x: number, y: number, z: number): number {
  return x | (y << POSITION_BITS) | (z << (POSITION_BITS * 2));
}

function decodePositionX(value: number): number {
  return value & POSITION_MASK;
}

function decodePositionY(value: number): number {
  return (value >> POSITION_BITS) & POSITION_MASK;
}

function decodePositionZ(value: number): number {
  return (value >> (POSITION_BITS * 2)) & POSITION_MASK;
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

function isOccluder(blockType: string): boolean {
  const kind = getRenderKind(blockType) ?? "opaque";
  return kind === "opaque" || kind === "emissive";
}

function canBlockEmitAnyFace(
  block: VoxelBuild["blocks"][number],
  blocksByPos: Map<number, string>,
): boolean {
  for (const d of DIRS) {
    const neighborType = blocksByPos.get(
      encodePosition(block.x + d.dx, block.y + d.dy, block.z + d.dz),
    );
    if (!neighborType) return true;
    if (neighborType === block.type) continue;
    if (isOccluder(neighborType)) continue;
    return true;
  }
  return false;
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
const WATER_TEXTURE_KEY = "water_still";

let cachedWaterTexture: { atlasTexture: THREE.Texture; texture: THREE.Texture } | null = null;

function faceTint(blockType: string, face: Face): [number, number, number] {
  if (blockType === "oak_leaves") return TINT_LEAVES;
  if (blockType === WATER_BLOCK_ID) return TINT_WATER;
  if (blockType === "grass_block" && face === "up") return TINT_GRASS;
  return TINT_WHITE;
}

function bucketFor(blockType: string, buckets: {
  opaque: MeshBucket;
  cutout: MeshBucket;
  transparent: MeshBucket;
  emissive: MeshBucket;
}): MeshBucket {
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

function configureAtlasTexture(atlasTexture: THREE.Texture) {
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
}

function getWaterSurfaceTexture(atlasTexture: THREE.Texture): THREE.Texture | null {
  if (cachedWaterTexture?.atlasTexture === atlasTexture) {
    return cachedWaterTexture.texture;
  }
  if (typeof document === "undefined") {
    return null;
  }

  const source = atlasTexture.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  const waterUv = hasAtlasKey(WATER_TEXTURE_KEY) ? getAtlasUv(WATER_TEXTURE_KEY) : null;
  const width = source?.width;
  const height = source?.height;
  if (!source || !waterUv || typeof width !== "number" || typeof height !== "number") {
    return null;
  }

  if (cachedWaterTexture) {
    cachedWaterTexture.texture.dispose();
    cachedWaterTexture = null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, waterUv.w);
  canvas.height = Math.max(1, waterUv.h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, waterUv.x, waterUv.y, waterUv.w, waterUv.h, 0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = atlasTexture.flipY;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  cachedWaterTexture = { atlasTexture, texture };
  return texture;
}

function buildBoundsFromPrepared(prepared: PreparedMeshData) {
  const box = new THREE.Box3(
    new THREE.Vector3(
      prepared.minX - prepared.cx,
      prepared.minY - prepared.cy,
      prepared.minZ - prepared.cz,
    ),
    new THREE.Vector3(
      prepared.maxX - prepared.cx + 1,
      prepared.maxY - prepared.cy + 1,
      prepared.maxZ - prepared.cz + 1,
    ),
  );
  const center = box.getCenter(new THREE.Vector3());
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 0.001;
  return { box, center, radius };
}

function serializeBounds(bounds: { box: THREE.Box3; center: THREE.Vector3; radius: number }): SerializedBuildBounds {
  return {
    min: [bounds.box.min.x, bounds.box.min.y, bounds.box.min.z],
    max: [bounds.box.max.x, bounds.box.max.y, bounds.box.max.z],
    center: [bounds.center.x, bounds.center.y, bounds.center.z],
    radius: bounds.radius,
  };
}

function deserializeBounds(bounds: SerializedBuildBounds) {
  const box = new THREE.Box3(
    new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]),
    new THREE.Vector3(bounds.max[0], bounds.max[1], bounds.max[2]),
  );
  const center = new THREE.Vector3(bounds.center[0], bounds.center[1], bounds.center[2]);
  const radius = Number.isFinite(bounds.radius) && bounds.radius > 0 ? bounds.radius : 0.001;
  return { box, center, radius };
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

function collectPayloadTransferables(payload: VoxelMeshPayload): Transferable[] {
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

function prepareMeshData(
  build: VoxelBuild,
  palette: BlockDefinition[],
  blockLimit?: number,
): PreparedMeshData {
  const allowed = new Set(palette.map((p) => p.id));
  const nonWaterBlocks: VoxelBuild["blocks"] = [];
  const waterBlocks: VoxelBuild["blocks"] = [];
  const blocksByPos = new Map<number, string>();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

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
  }

  for (let i = 0; i < maxInputBlocks; i += 1) {
    const b = build.blocks[i];
    if (!b || !allowed.has(b.type)) continue;
    if (b.type === WATER_BLOCK_ID) {
      waterBlocks.push(b);
      continue;
    }
    if (!canBlockEmitAnyFace(b, blocksByPos)) continue;
    nonWaterBlocks.push(b);
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

async function prepareMeshDataAsync(
  build: VoxelBuild,
  palette: BlockDefinition[],
  blockLimit: number | undefined,
  maybeYield: (progress?: BuildProgress) => Promise<void>,
): Promise<PreparedMeshData> {
  const allowed = new Set(palette.map((p) => p.id));
  const nonWaterBlocks: VoxelBuild["blocks"] = [];
  const waterBlocks: VoxelBuild["blocks"] = [];
  const blocksByPos = new Map<number, string>();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

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
    if ((i & 0x03ff) === 0) {
      await maybeYield({
        processedBlocks: i,
        totalBlocks: Math.max(1, maxInputBlocks),
        stageLabel: "Indexing blocks",
      });
    }
  }

  for (let i = 0; i < maxInputBlocks; i += 1) {
    const b = build.blocks[i];
    if (!b || !allowed.has(b.type)) continue;
    if (b.type === WATER_BLOCK_ID) {
      waterBlocks.push(b);
      continue;
    }
    if (!canBlockEmitAnyFace(b, blocksByPos)) continue;
    nonWaterBlocks.push(b);
    if ((i & 0x03ff) === 0) {
      await maybeYield({
        processedBlocks: i,
        totalBlocks: Math.max(1, maxInputBlocks),
        stageLabel: "Filtering hidden blocks",
      });
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
      if (isOccluder(neighborType)) continue;
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

function collectWaterPlanes(prepared: PreparedMeshData) {
  const planes = new Map<string, { face: Face; plane: number; cells: Set<number> }>();
  if (!prepared.allowed.has(WATER_BLOCK_ID) || prepared.waterBlocks.length === 0) return planes;

  for (const block of prepared.waterBlocks) {

    for (const d of DIRS) {
      const neighborType = prepared.blocksByPos.get(
        encodePosition(block.x + d.dx, block.y + d.dy, block.z + d.dz),
      );
      if (neighborType) {
        if (neighborType === WATER_BLOCK_ID) continue;
        if (isOccluder(neighborType)) continue;
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
  }

  return planes;
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

      appendWaterRect(
        bucket,
        face,
        plane,
        minU + u,
        minV + v,
        rectWidth,
        rectHeight,
        prepared,
      );
    }
  }
}

function buildWaterSurfaceBucket(prepared: PreparedMeshData): MeshBucket {
  const bucket = makeBucket();
  const planes = collectWaterPlanes(prepared);
  for (const plane of planes.values()) {
    appendMergedPlaneFaces(bucket, plane.face, plane.plane, plane.cells, prepared);
  }
  return bucket;
}

async function buildWaterSurfaceBucketAsync(
  prepared: PreparedMeshData,
  maybeYield: (progress?: BuildProgress) => Promise<void>,
): Promise<MeshBucket> {
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
        if (isOccluder(neighborType)) continue;
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

    if ((i & 0x01ff) === 0) {
      await maybeYield({
        processedBlocks: i,
        totalBlocks: Math.max(1, prepared.waterBlocks.length),
        stageLabel: "Meshing water",
      });
    }
  }

  let processedPlanes = 0;
  const totalPlanes = Math.max(1, planes.size);
  for (const plane of planes.values()) {
    appendMergedPlaneFaces(bucket, plane.face, plane.plane, plane.cells, prepared);
    processedPlanes += 1;
    if ((processedPlanes & 0x1f) === 0) {
      await maybeYield({
        processedBlocks: prepared.nonWaterBlocks.length + processedPlanes,
        totalBlocks: prepared.nonWaterBlocks.length + totalPlanes,
        stageLabel: "Meshing water",
      });
    }
  }

  return bucket;
}

export function createVoxelGroup(build: VoxelBuild, palette: BlockDefinition[], atlasTexture: THREE.Texture): VoxelGroup {
  const prepared = prepareMeshData(build, palette);
  const bounds = buildBoundsFromPrepared(prepared);
  const opaque = makeBucket();
  const cutout = makeBucket();
  const transparent = makeBucket();
  const emissive = makeBucket();

  for (const block of prepared.nonWaterBlocks) {
    appendStandardFaces(block, prepared, { opaque, cutout, transparent, emissive });
  }

  const water = buildWaterSurfaceBucket(prepared);

  configureAtlasTexture(atlasTexture);
  const waterTexture = getWaterSurfaceTexture(atlasTexture);

  const matOpaque = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true });
  const matCutout = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    alphaTest: 0.45,
    vertexColors: true,
  });
  const matTransparent = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    vertexColors: true,
  });
  const matWater = new THREE.MeshLambertMaterial({
    map: waterTexture ?? undefined,
    color: 0xffffff,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(0x0b214f),
    emissiveIntensity: 0.18,
    vertexColors: true,
  });
  const matEmissive = new THREE.MeshBasicMaterial({
    map: atlasTexture,
    vertexColors: true,
  });

  const group = new THREE.Group();
  group.name = "VoxelGroup";

  const geoOpaque = buildGeometry(opaque, bounds);
  const geoCutout = buildGeometry(cutout, bounds);
  const geoTransparent = buildGeometry(transparent, bounds);
  const geoWater = buildGeometry(water, bounds);
  const geoEmissive = buildGeometry(emissive, bounds);

  if (geoOpaque) group.add(new THREE.Mesh(geoOpaque, matOpaque));
  if (geoCutout) group.add(new THREE.Mesh(geoCutout, matCutout));
  if (geoTransparent) group.add(new THREE.Mesh(geoTransparent, matTransparent));
  if (geoWater) {
    const mesh = new THREE.Mesh(geoWater, matWater);
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  if (geoEmissive) group.add(new THREE.Mesh(geoEmissive, matEmissive));

  return {
    group,
    dispose: () => disposeObject(group),
    bounds,
    stats: { blockCount: prepared.filteredBlockCount },
  };
}

type MeshWorkerRequest = {
  type: "build";
  build: VoxelBuild;
  allowedBlockIds: string[];
  blockLimit?: number;
};

type MeshWorkerResponse =
  | { type: "progress"; progress: BuildProgress }
  | { type: "complete"; payload: VoxelMeshPayload }
  | { type: "error"; message: string };

function createVoxelGroupFromMeshPayload(
  payload: VoxelMeshPayload,
  atlasTexture: THREE.Texture,
): VoxelGroup {
  const bounds = deserializeBounds(payload.bounds);
  configureAtlasTexture(atlasTexture);
  const waterTexture = getWaterSurfaceTexture(atlasTexture);

  const matOpaque = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true });
  const matCutout = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    alphaTest: 0.45,
    vertexColors: true,
  });
  const matTransparent = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    vertexColors: true,
  });
  const matWater = new THREE.MeshLambertMaterial({
    map: waterTexture ?? undefined,
    color: 0xffffff,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(0x0b214f),
    emissiveIntensity: 0.18,
    vertexColors: true,
  });
  const matEmissive = new THREE.MeshBasicMaterial({
    map: atlasTexture,
    vertexColors: true,
  });

  const group = new THREE.Group();
  group.name = "VoxelGroup";

  const geoOpaque = buildGeometryFromSerialized(payload.opaque, bounds);
  const geoCutout = buildGeometryFromSerialized(payload.cutout, bounds);
  const geoTransparent = buildGeometryFromSerialized(payload.transparent, bounds);
  const geoWater = buildGeometryFromSerialized(payload.water, bounds);
  const geoEmissive = buildGeometryFromSerialized(payload.emissive, bounds);

  if (geoOpaque) group.add(new THREE.Mesh(geoOpaque, matOpaque));
  if (geoCutout) group.add(new THREE.Mesh(geoCutout, matCutout));
  if (geoTransparent) group.add(new THREE.Mesh(geoTransparent, matTransparent));
  if (geoWater) {
    const mesh = new THREE.Mesh(geoWater, matWater);
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  if (geoEmissive) group.add(new THREE.Mesh(geoEmissive, matEmissive));

  return {
    group,
    dispose: () => disposeObject(group),
    bounds,
    stats: { blockCount: payload.filteredBlockCount },
  };
}

async function createVoxelMeshPayloadInWorker(
  build: VoxelBuild,
  palette: BlockDefinition[],
  opts?: CreateVoxelGroupAsyncOpts,
): Promise<VoxelMeshPayload> {
  const cacheKey = opts?.cacheKey?.trim();
  if (cacheKey) {
    const cached = await getCachedMeshPayload(cacheKey);
    if (cached) return cached;
  }

  if (typeof Worker === "undefined") {
    throw new Error("Web Workers are unavailable in this environment");
  }

  const worker = new Worker(new URL("./mesh.worker.ts", import.meta.url), { type: "module" });
  const abort = () => {
    worker.terminate();
  };

  return await new Promise<VoxelMeshPayload>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (opts?.signal) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    };
    const finishResolve = (payload: VoxelMeshPayload) => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      if (cacheKey) {
        void setCachedMeshPayload(cacheKey, payload);
      }
      resolve(payload);
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onAbort = () => {
      abort();
      finishReject(new DOMException("Aborted", "AbortError"));
    };

    worker.onmessage = (event: MessageEvent<MeshWorkerResponse>) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "progress") {
        opts?.onProgress?.(message.progress);
        return;
      }
      if (message.type === "error") {
        finishReject(new Error(message.message || "Mesh worker failed"));
        return;
      }
      if (message.type === "complete") {
        finishResolve(message.payload);
      }
    };
    worker.onerror = (event) => {
      finishReject(new Error(event.message || "Mesh worker crashed"));
    };

    if (opts?.signal?.aborted) {
      onAbort();
      return;
    }
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    const request: MeshWorkerRequest = {
      type: "build",
      build,
      allowedBlockIds: palette.map((entry) => entry.id),
      blockLimit: opts?.blockLimit,
    };
    worker.postMessage(request);
  });
}

// Async variant that periodically yields to keep the main thread responsive during huge builds.
async function createVoxelGroupAsyncLocal(
  build: VoxelBuild,
  palette: BlockDefinition[],
  atlasTexture: THREE.Texture,
  opts?: CreateVoxelGroupAsyncOpts,
): Promise<VoxelGroup> {
  const yieldAfterMs = Number.isFinite(opts?.yieldAfterMs) ? Math.max(1, opts?.yieldAfterMs ?? 12) : 12;
  let lastYieldAt = nowMs();
  const maybeYield = async (emitProgress?: BuildProgress) => {
    throwIfAborted(opts?.signal);
    if (!Number.isFinite(yieldAfterMs) || yieldAfterMs <= 0) return;
    const now = nowMs();
    if (now - lastYieldAt < yieldAfterMs) return;
    lastYieldAt = now;
    if (emitProgress) opts?.onProgress?.(emitProgress);
    await yieldToMainThread();
  };
  const yieldNow = async (emitProgress?: BuildProgress) => {
    throwIfAborted(opts?.signal);
    if (emitProgress) opts?.onProgress?.(emitProgress);
    lastYieldAt = nowMs();
    await yieldToMainThread();
  };

  const prepared = await prepareMeshDataAsync(build, palette, opts?.blockLimit, maybeYield);
  const bounds = buildBoundsFromPrepared(prepared);
  const opaque = makeBucket();
  const cutout = makeBucket();
  const transparent = makeBucket();
  const emissive = makeBucket();

  for (let i = 0; i < prepared.nonWaterBlocks.length; i += 1) {
    const block = prepared.nonWaterBlocks[i];
    appendStandardFaces(block, prepared, { opaque, cutout, transparent, emissive });
    if ((i & 0x01ff) === 0) {
      await maybeYield({
        processedBlocks: i,
        totalBlocks: Math.max(1, prepared.nonWaterBlocks.length),
        stageLabel: "Meshing blocks",
      });
    }
  }

  const water = await buildWaterSurfaceBucketAsync(prepared, maybeYield);

  const geometryStageCount = 5;
  const geometryStageTotal = prepared.filteredBlockCount + geometryStageCount;
  await yieldNow({
    processedBlocks: prepared.filteredBlockCount,
    totalBlocks: geometryStageTotal,
    stageLabel: "Finalizing geometry",
  });

  configureAtlasTexture(atlasTexture);
  const waterTexture = getWaterSurfaceTexture(atlasTexture);

  const matOpaque = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true });
  const matCutout = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    alphaTest: 0.45,
    vertexColors: true,
  });
  const matTransparent = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    vertexColors: true,
  });
  const matWater = new THREE.MeshLambertMaterial({
    map: waterTexture ?? undefined,
    color: 0xffffff,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    side: THREE.DoubleSide,
    emissive: new THREE.Color(0x0b214f),
    emissiveIntensity: 0.18,
    vertexColors: true,
  });
  const matEmissive = new THREE.MeshBasicMaterial({
    map: atlasTexture,
    vertexColors: true,
  });

  const group = new THREE.Group();
  group.name = "VoxelGroup";

  const geoOpaque = buildGeometry(opaque, bounds);
  await yieldNow({
    processedBlocks: prepared.filteredBlockCount + 1,
    totalBlocks: geometryStageTotal,
    stageLabel: "Finalizing geometry",
  });
  const geoCutout = buildGeometry(cutout, bounds);
  await yieldNow({
    processedBlocks: prepared.filteredBlockCount + 2,
    totalBlocks: geometryStageTotal,
    stageLabel: "Finalizing geometry",
  });
  const geoTransparent = buildGeometry(transparent, bounds);
  await yieldNow({
    processedBlocks: prepared.filteredBlockCount + 3,
    totalBlocks: geometryStageTotal,
    stageLabel: "Finalizing geometry",
  });
  const geoWater = buildGeometry(water, bounds);
  await yieldNow({
    processedBlocks: prepared.filteredBlockCount + 4,
    totalBlocks: geometryStageTotal,
    stageLabel: "Finalizing geometry",
  });
  const geoEmissive = buildGeometry(emissive, bounds);
  opts?.onProgress?.({
    processedBlocks: geometryStageTotal,
    totalBlocks: geometryStageTotal,
    stageLabel: "Finalizing geometry",
  });

  if (geoOpaque) group.add(new THREE.Mesh(geoOpaque, matOpaque));
  if (geoCutout) group.add(new THREE.Mesh(geoCutout, matCutout));
  if (geoTransparent) group.add(new THREE.Mesh(geoTransparent, matTransparent));
  if (geoWater) {
    const mesh = new THREE.Mesh(geoWater, matWater);
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  if (geoEmissive) group.add(new THREE.Mesh(geoEmissive, matEmissive));

  return {
    group,
    dispose: () => disposeObject(group),
    bounds,
    stats: { blockCount: prepared.filteredBlockCount },
  };
}

export async function createVoxelGroupAsync(
  build: VoxelBuild,
  palette: BlockDefinition[],
  atlasTexture: THREE.Texture,
  opts?: CreateVoxelGroupAsyncOpts,
): Promise<VoxelGroup> {
  try {
    const payload = await createVoxelMeshPayloadInWorker(build, palette, opts);
    throwIfAborted(opts?.signal);
    return createVoxelGroupFromMeshPayload(payload, atlasTexture);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    console.warn("Voxel mesh worker failed, falling back to main-thread meshing", err);
    return createVoxelGroupAsyncLocal(build, palette, atlasTexture, opts);
  }
}
