import { decodeBinaryVoxelBuild } from "@/lib/voxel/binaryBuild";
import {
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  voxelWorldPartUrl,
  type VoxelWorldBounds,
  type VoxelWorldDelivery,
  type VoxelWorldManifest,
  type VoxelWorldMixedRegion,
  type VoxelWorldPartRef,
  type VoxelWorldRegion,
  type VoxelWorldRegionPage,
  type VoxelWorldRegionPageRef,
  type VoxelWorldUniformRegion,
} from "@/lib/voxel/world";
import {
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";

export const EXPLORER_PLAYER_WIDTH = 0.6;
export const EXPLORER_PLAYER_HEIGHT = 1.8;
export const EXPLORER_EYE_HEIGHT = 1.62;
const MIN_NOCLIP_SPEED_MULTIPLIER = 1;
const MAX_NOCLIP_SPEED_MULTIPLIER = 10;

const PLAYER_HALF_WIDTH = EXPLORER_PLAYER_WIDTH / 2;
const MAX_COLLISION_AXIS = 8192;
// Local cells live in 8^3 chunk bitsets. At 8192 per axis the chunk key still
// stays below 2^30, while empty space between distant blocks costs nothing.
const COLLISION_CHUNK_BITS = 3;
const COLLISION_CHUNK_SIZE = 1 << COLLISION_CHUNK_BITS;
const COLLISION_CHUNK_MASK = COLLISION_CHUNK_SIZE - 1;
const COLLISION_CHUNK_BYTES = (COLLISION_CHUNK_SIZE ** 3) / 8;
const COLLISION_EPSILON = 1e-5;
const YIELD_EVERY_BLOCKS = 262_144;
const WORLD_LOAD_RADIUS = 96;
const WORLD_SPAWN_LOAD_RADIUS = 8;
const WORLD_MAX_COLLISION_PAGES = 8;
const WORLD_MAX_COLLISION_REGIONS = 128;
const SPAWN_CLEARANCE = 0.2;

export type ExplorerPosition = { x: number; y: number; z: number };
export type ExplorerAxis = "x" | "y" | "z";

export function adjustExplorerNoclipSpeedMultiplier(current: number, deltaY: number) {
  const next = deltaY < 0 ? current + 1 : deltaY > 0 ? current - 1 : current;
  return Math.min(
    MAX_NOCLIP_SPEED_MULTIPLIER,
    Math.max(MIN_NOCLIP_SPEED_MULTIPLIER, next),
  );
}

export function setExplorerMoveDirection(
  target: ExplorerPosition,
  forward: ExplorerPosition,
  right: ExplorerPosition,
  forwardInput: number,
  rightInput: number,
  verticalInput: number,
) {
  target.x = forward.x * forwardInput + right.x * rightInput;
  target.y = forward.y * forwardInput + right.y * rightInput + verticalInput;
  target.z = forward.z * forwardInput + right.z * rightInput;
  const lengthSquared = target.x ** 2 + target.y ** 2 + target.z ** 2;
  if (lengthSquared <= 1) return;
  const scale = 1 / Math.sqrt(lengthSquared);
  target.x *= scale;
  target.y *= scale;
  target.z *= scale;
}

export type ExplorerCollisionWorld = {
  height: number;
  spawnPosition: ExplorerPosition;
  collides: (position: ExplorerPosition) => boolean;
  isInWater: (position: ExplorerPosition) => boolean;
  updateActiveCamera?: (position: ExplorerPosition) => Promise<void>;
};

type BuildProgress = {
  processedBlocks: number;
  totalBlocks: number;
};

type CellBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type WorldTransform = {
  centerX: number;
  centerZ: number;
  originY: number;
  width: number;
  height: number;
  depth: number;
  bounds: CellBounds;
};

type LoadedMixedCollisionRegion = {
  region: VoxelWorldMixedRegion;
  solids: Uint8Array | null;
  water: Uint8Array | null;
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function yieldToMainThread() {
  const schedulerApi = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof schedulerApi?.yield === "function") {
    await schedulerApi.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function gunzipVoxelWorldPart(bytes: Uint8Array): Promise<Uint8Array> {
  const DecompressionStreamCtor = (globalThis as typeof globalThis & {
    DecompressionStream?: typeof DecompressionStream;
  }).DecompressionStream;
  if (typeof DecompressionStreamCtor !== "function") {
    throw new Error("This browser cannot decompress voxel world parts");
  }
  const decompressor = new DecompressionStreamCtor("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(decompressor);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readVoxelWorldPartBytes(
  delivery: VoxelWorldDelivery,
  ref: VoxelWorldPartRef,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const encoded = delivery.resolvePart
    ? await delivery.resolvePart(ref.key, signal)
    : await (async () => {
        const response = await fetch(voxelWorldPartUrl(delivery, ref.key), { signal });
        if (!response.ok) throw new Error(`Voxel world part ${ref.key} failed to load`);
        return new Uint8Array(await response.arrayBuffer());
      })();
  throwIfAborted(signal);
  return ref.encoding === "gzip" && encoded[0] === 0x1f && encoded[1] === 0x8b
    ? gunzipVoxelWorldPart(encoded)
    : encoded;
}

function setBit(bits: Uint8Array, index: number) {
  bits[index >>> 3] |= 1 << (index & 7);
}

function hasBit(bits: Uint8Array | null, index: number): boolean {
  return Boolean(bits && (bits[index >>> 3] & (1 << (index & 7))));
}

function getChunk(chunks: Map<number, Uint8Array>, key: number): Uint8Array {
  let chunk = chunks.get(key);
  if (chunk) return chunk;
  chunk = new Uint8Array(COLLISION_CHUNK_BYTES);
  chunks.set(key, chunk);
  return chunk;
}

function materialIsSolid(type: string): boolean {
  return type !== "water" && type !== "lava";
}

function materialIsSpawnSurface(type: string): boolean {
  return type !== "lava";
}

function worldTransformFromBounds(bounds: VoxelWorldBounds): WorldTransform {
  return {
    centerX: bounds.origin.x + bounds.size.x / 2,
    centerZ: bounds.origin.z + bounds.size.z / 2,
    originY: bounds.origin.y,
    width: bounds.size.x,
    height: bounds.size.y,
    depth: bounds.size.z,
    bounds: boundsToCellBounds(bounds),
  };
}

function boundsToCellBounds(bounds: VoxelWorldBounds): CellBounds {
  return {
    minX: bounds.origin.x,
    minY: bounds.origin.y,
    minZ: bounds.origin.z,
    maxX: bounds.origin.x + bounds.size.x - 1,
    maxY: bounds.origin.y + bounds.size.y - 1,
    maxZ: bounds.origin.z + bounds.size.z - 1,
  };
}

function regionCellBounds(region: Pick<VoxelWorldRegion, "origin" | "size">): CellBounds {
  return {
    minX: region.origin.x,
    minY: region.origin.y,
    minZ: region.origin.z,
    maxX: region.origin.x + region.size.x - 1,
    maxY: region.origin.y + region.size.y - 1,
    maxZ: region.origin.z + region.size.z - 1,
  };
}

function intersectsBounds(a: CellBounds, b: CellBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY &&
    a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function containsColumn(bounds: CellBounds, x: number, z: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

function playerCellBounds(transform: WorldTransform, position: ExplorerPosition): CellBounds {
  const feetY = position.y - EXPLORER_EYE_HEIGHT;
  return {
    minX: Math.floor(position.x - PLAYER_HALF_WIDTH + transform.centerX + COLLISION_EPSILON),
    maxX: Math.floor(position.x + PLAYER_HALF_WIDTH + transform.centerX - COLLISION_EPSILON),
    minY: Math.floor(feetY + transform.originY + COLLISION_EPSILON),
    maxY: Math.floor(feetY + EXPLORER_PLAYER_HEIGHT + transform.originY - COLLISION_EPSILON),
    minZ: Math.floor(position.z - PLAYER_HALF_WIDTH + transform.centerZ + COLLISION_EPSILON),
    maxZ: Math.floor(position.z + PLAYER_HALF_WIDTH + transform.centerZ - COLLISION_EPSILON),
  };
}

function cameraRawCell(transform: WorldTransform, position: ExplorerPosition) {
  return {
    x: Math.floor(position.x + transform.centerX),
    y: Math.floor(position.y + transform.originY - EXPLORER_EYE_HEIGHT),
    z: Math.floor(position.z + transform.centerZ),
  };
}

function loadBoundsAround(transform: WorldTransform, rawX: number, rawZ: number, radius: number, rawY?: number): CellBounds {
  return {
    minX: rawX - radius,
    maxX: rawX + radius,
    minY: rawY == null ? transform.bounds.minY - radius : rawY - radius,
    maxY: rawY == null ? transform.bounds.maxY + radius : rawY + radius,
    minZ: rawZ - radius,
    maxZ: rawZ + radius,
  };
}

function distanceToCells(cells: CellBounds, x: number, y: number, z: number): number {
  return Math.max(cells.minX - x, 0, x - cells.maxX) ** 2
    + Math.max(cells.minY - y, 0, y - cells.maxY) ** 2
    + Math.max(cells.minZ - z, 0, z - cells.maxZ) ** 2;
}

function mixedBitIndex(region: VoxelWorldMixedRegion, rawX: number, rawY: number, rawZ: number): number {
  const x = rawX - region.origin.x;
  const y = rawY - region.origin.y;
  const z = rawZ - region.origin.z;
  return x + region.size.x * (z + region.size.z * y);
}

function mixedIntersects(
  loaded: LoadedMixedCollisionRegion,
  cells: CellBounds,
  layer: "solids" | "water",
): boolean {
  const bits = loaded[layer];
  if (!bits) return false;
  const regionBounds = regionCellBounds(loaded.region);
  if (!intersectsBounds(regionBounds, cells)) return false;

  const minX = Math.max(regionBounds.minX, cells.minX);
  const maxX = Math.min(regionBounds.maxX, cells.maxX);
  const minY = Math.max(regionBounds.minY, cells.minY);
  const maxY = Math.min(regionBounds.maxY, cells.maxY);
  const minZ = Math.max(regionBounds.minZ, cells.minZ);
  const maxZ = Math.min(regionBounds.maxZ, cells.maxZ);
  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (hasBit(bits, mixedBitIndex(loaded.region, x, y, z))) return true;
      }
    }
  }
  return false;
}

function buildLoadedMixedCollisionRegion(region: VoxelWorldMixedRegion, bytes: Uint8Array): LoadedMixedCollisionRegion {
  const packed = decodeBinaryVoxelBuild(bytes);
  if (packed.count !== region.blockCount) {
    throw new Error(`Voxel world region ${region.key} block count mismatch`);
  }

  const cellCount = region.size.x * region.size.y * region.size.z;
  const solids = new Uint8Array(Math.ceil(cellCount / 8));
  const water = new Uint8Array(Math.ceil(cellCount / 8));
  let hasSolids = false;
  let hasWater = false;

  for (let i = 0; i < packed.count; i += 1) {
    const x = packed.positions[i * 3];
    const y = packed.positions[i * 3 + 1];
    const z = packed.positions[i * 3 + 2];
    if (x >= region.size.x || y >= region.size.y || z >= region.size.z) {
      throw new Error(`Voxel world region ${region.key} has out-of-bounds local blocks`);
    }
    const type = packed.typeNames[packed.typeIds[i]] ?? "";
    const index = x + region.size.x * (z + region.size.z * y);
    if (type === "water") {
      setBit(water, index);
      hasWater = true;
    } else if (materialIsSolid(type)) {
      setBit(solids, index);
      hasSolids = true;
    }
  }

  return {
    region,
    solids: hasSolids ? solids : null,
    water: hasWater ? water : null,
  };
}

async function createVoxelWorldCollisionWorld(
  delivery: VoxelWorldDelivery,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (progress: BuildProgress) => void;
  },
): Promise<ExplorerCollisionWorld> {
  const parsed = parseVoxelWorldManifest(delivery.manifest, {
    allowLocalBlobRefs: Boolean(delivery.resolvePart),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const manifest: VoxelWorldManifest = parsed.value;
  if (manifest.exactBlockCount === 0 || !manifest.bounds) throw new Error("Build has no blocks");

  const transform = worldTransformFromBounds(manifest.bounds);
  const uniformRegions = new Map<string, VoxelWorldUniformRegion>();
  const mixedRegions = new Map<string, VoxelWorldMixedRegion>();
  const loadedMixedRegions = new Map<string, LoadedMixedCollisionRegion>();
  const pageRefs = manifest.regionPages ?? [];
  const loadedPages = new Map<number, VoxelWorldRegionPage>();
  const regionBuckets = new Map<string, VoxelWorldRegion[]>();
  let activeBounds = transform.bounds;
  let unloadedPages = pageRefs;
  const bucketCoordinate = (value: number) => Math.floor(value / manifest.leafSize);
  const bucketKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

  const nearbyRegions = (cells: CellBounds) => {
    const regions = new Set<VoxelWorldRegion>();
    for (let y = bucketCoordinate(cells.minY); y <= bucketCoordinate(cells.maxY); y++) {
      for (let z = bucketCoordinate(cells.minZ); z <= bucketCoordinate(cells.maxZ); z++) {
        for (let x = bucketCoordinate(cells.minX); x <= bucketCoordinate(cells.maxX); x++) {
          for (const region of regionBuckets.get(bucketKey(x, y, z)) ?? []) regions.add(region);
        }
      }
    }
    return regions;
  };

  const addRegions = (regions: readonly VoxelWorldRegion[]) => {
    for (const region of regions) {
      if (region.kind === "uniform") {
        uniformRegions.set(region.key, region);
      } else if (!mixedRegions.has(region.key)) {
        mixedRegions.set(region.key, region);
      }
    }
  };

  addRegions(manifest.regions ?? []);

  const readPage = async (pageRef: VoxelWorldRegionPageRef): Promise<VoxelWorldRegionPage> => {
    const bytes = await readVoxelWorldPartBytes(delivery, pageRef.data, opts?.signal);
    throwIfAborted(opts?.signal);
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const page = parseVoxelWorldRegionPage(decoded, {
      gridSize: manifest.gridSize,
      worldBounds: manifest.bounds,
      pageRef,
      allowLocalBlobRefs: Boolean(delivery.resolvePart),
    });
    if (!page.ok) throw new Error(page.error);
    return page.value;
  };

  const loadMixedRegion = async (region: VoxelWorldMixedRegion): Promise<void> => {
    if (loadedMixedRegions.has(region.key)) return;
    const bytes = await readVoxelWorldPartBytes(delivery, region.data, opts?.signal);
    loadedMixedRegions.set(region.key, buildLoadedMixedCollisionRegion(region, bytes));
  };

  const loadNear = async (rawX: number, rawZ: number, radius: number, rawY?: number) => {
    throwIfAborted(opts?.signal);
    const nextBounds = loadBoundsAround(transform, rawX, rawZ, radius, rawY);
    const distance = (cells: CellBounds) => distanceToCells(cells, rawX, rawY ?? transform.bounds.maxY, rawZ);
    const wantedPages = new Set(pageRefs
      .filter((page) => intersectsBounds(boundsToCellBounds(page.bounds), nextBounds))
      .sort((a, b) => distance(boundsToCellBounds(a.bounds)) - distance(boundsToCellBounds(b.bounds)))
      .slice(0, WORLD_MAX_COLLISION_PAGES).map((page) => page.index));
    for (const [index, page] of loadedPages) {
      if (wantedPages.has(index)) continue;
      loadedPages.delete(index);
      for (const region of page.regions) {
        uniformRegions.delete(region.key);
        mixedRegions.delete(region.key);
      }
    }
    for (const page of pageRefs) {
      if (wantedPages.has(page.index) && !loadedPages.has(page.index)) {
        const pageData = await readPage(page);
        addRegions(pageData.regions);
        loadedPages.set(page.index, pageData);
        await yieldToMainThread();
      }
    }

    activeBounds = nextBounds;
    unloadedPages = pageRefs.filter((page) => !loadedPages.has(page.index) && intersectsBounds(boundsToCellBounds(page.bounds), activeBounds));
    regionBuckets.clear();
    for (const region of [...uniformRegions.values(), ...mixedRegions.values()]) {
      const cells = regionCellBounds(region);
      if (!intersectsBounds(cells, activeBounds)) continue;
      for (let y = bucketCoordinate(Math.max(cells.minY, activeBounds.minY)); y <= bucketCoordinate(Math.min(cells.maxY, activeBounds.maxY)); y++) {
        for (let z = bucketCoordinate(Math.max(cells.minZ, activeBounds.minZ)); z <= bucketCoordinate(Math.min(cells.maxZ, activeBounds.maxZ)); z++) {
          for (let x = bucketCoordinate(Math.max(cells.minX, activeBounds.minX)); x <= bucketCoordinate(Math.min(cells.maxX, activeBounds.maxX)); x++) {
            const key = bucketKey(x, y, z);
            const bucket = regionBuckets.get(key) ?? [];
            if (bucket.length === 0) regionBuckets.set(key, bucket);
            bucket.push(region);
          }
        }
      }
    }
    const wantedMixed = Array.from(mixedRegions.values())
      .filter((region) => intersectsBounds(regionCellBounds(region), activeBounds))
      .sort((a, b) => distance(regionCellBounds(a)) - distance(regionCellBounds(b)))
      .slice(0, WORLD_MAX_COLLISION_REGIONS);
    const wantedMixedKeys = new Set(wantedMixed.map((region) => region.key));
    for (const key of loadedMixedRegions.keys()) {
      if (!wantedMixedKeys.has(key)) loadedMixedRegions.delete(key);
    }
    let lastYield = performance.now();
    for (const region of wantedMixed) {
      await loadMixedRegion(region);
      if (performance.now() - lastYield >= 8) {
        await yieldToMainThread();
        lastYield = performance.now();
      }
    }
    throwIfAborted(opts?.signal);
  };

  const centerRawX = Math.floor(transform.centerX);
  const centerRawZ = Math.floor(transform.centerZ);
  await loadNear(centerRawX, centerRawZ, WORLD_SPAWN_LOAD_RADIUS);

  const unloadedPageIntersects = (cells: CellBounds) => unloadedPages.some((pageRef) => (
    intersectsBounds(boundsToCellBounds(pageRef.bounds), cells)
  ));

  const highestTopAtColumn = async (rawX: number, rawZ: number): Promise<number | null> => {
    let top: number | null = null;
    const inspectRegions = async (regions: Iterable<VoxelWorldRegion>) => {
      const candidates = Array.from(regions)
        .filter((region) => containsColumn(regionCellBounds(region), rawX, rawZ))
        .sort((a, b) => b.origin.y + b.size.y - a.origin.y - a.size.y);
      for (const region of candidates) {
        throwIfAborted(opts?.signal);
        const cells = regionCellBounds(region);
        const upperTop = cells.maxY + 1 - transform.originY;
        if (top !== null && upperTop <= top) break;
        if (region.kind === "uniform") {
          if (materialIsSpawnSurface(region.type)) top = upperTop;
          continue;
        }
        let loaded = loadedMixedRegions.get(region.key);
        if (!loaded) {
          const bytes = await readVoxelWorldPartBytes(delivery, region.data, opts?.signal);
          throwIfAborted(opts?.signal);
          loaded = buildLoadedMixedCollisionRegion(region, bytes);
          await yieldToMainThread();
        }
        for (let rawY = cells.maxY; rawY >= cells.minY; rawY -= 1) {
          const index = mixedBitIndex(region, rawX, rawY, rawZ);
          if (hasBit(loaded.solids, index) || hasBit(loaded.water, index)) {
            top = Math.max(top ?? -Infinity, rawY + 1 - transform.originY);
            break;
          }
        }
      }
    };
    await inspectRegions([...uniformRegions.values(), ...mixedRegions.values()]);
    const pages = pageRefs
      .filter((page) => !loadedPages.has(page.index) && containsColumn(boundsToCellBounds(page.bounds), rawX, rawZ))
      .sort((a, b) => b.bounds.origin.y + b.bounds.size.y - a.bounds.origin.y - a.bounds.size.y);
    for (const page of pages) {
      if (top !== null && page.bounds.origin.y + page.bounds.size.y - transform.originY <= top) break;
      await inspectRegions((await readPage(page)).regions);
      await yieldToMainThread();
    }
    throwIfAborted(opts?.signal);
    return top;
  };

  const centerTop = await highestTopAtColumn(centerRawX, centerRawZ);
  const spawnPosition = {
    x: 0,
    y: (centerTop ?? 2) + EXPLORER_EYE_HEIGHT + SPAWN_CLEARANCE,
    z: 0,
  };
  let activeLoad: Promise<void> | null = null;

  opts?.onProgress?.({
    processedBlocks: manifest.exactBlockCount,
    totalBlocks: manifest.exactBlockCount,
  });

  return {
    height: transform.height,
    spawnPosition,
    collides(position) {
      const feetY = position.y - EXPLORER_EYE_HEIGHT;
      if (feetY < -COLLISION_EPSILON) return true;
      const cells = playerCellBounds(transform, position);
      if (cells.minX < activeBounds.minX || cells.maxX > activeBounds.maxX
        || cells.minY < activeBounds.minY || cells.maxY > activeBounds.maxY
        || cells.minZ < activeBounds.minZ || cells.maxZ > activeBounds.maxZ) return true;
      for (const region of nearbyRegions(cells)) {
        if (!intersectsBounds(regionCellBounds(region), cells)) continue;
        if (region.kind === "uniform") {
          if (materialIsSolid(region.type)) return true;
        } else {
          const loaded = loadedMixedRegions.get(region.key);
          if (!loaded || mixedIntersects(loaded, cells, "solids")) return true;
        }
      }
      return unloadedPageIntersects(cells);
    },
    isInWater(position) {
      const cells = playerCellBounds(transform, position);
      for (const region of nearbyRegions(cells)) {
        if (region.kind === "uniform") {
          if (region.type === "water" && intersectsBounds(regionCellBounds(region), cells)) return true;
        } else {
          const loaded = loadedMixedRegions.get(region.key);
          if (loaded && mixedIntersects(loaded, cells, "water")) return true;
        }
      }
      return false;
    },
    async updateActiveCamera(position) {
      if (activeLoad) return activeLoad;
      const raw = cameraRawCell(transform, position);
      activeLoad = loadNear(raw.x, raw.z, WORLD_LOAD_RADIUS, raw.y).finally(() => {
        activeLoad = null;
      });
      return activeLoad;
    },
  };
}

export async function createExplorerCollisionWorld(
  build: RenderableVoxelBuild,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (progress: BuildProgress) => void;
  },
): Promise<ExplorerCollisionWorld> {
  if (build.world) return createVoxelWorldCollisionWorld(build.world, opts);

  const blockCount = voxelBuildBlockCount(build);
  if (blockCount === 0) throw new Error("Build has no blocks");

  const packed = build.packed;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let hasWaterBlocks = false;

  for (let i = 0; i < blockCount; i += 1) {
    const block = packed ? null : build.blocks[i];
    const x = packed ? packed.positions[i * 3] : block?.x;
    const y = packed ? packed.positions[i * 3 + 1] : block?.y;
    const z = packed ? packed.positions[i * 3 + 2] : block?.z;
    const type = packed ? packed.typeNames[packed.typeIds[i]] : block?.type;
    if (
      typeof x !== "number" || !Number.isInteger(x) ||
      typeof y !== "number" || !Number.isInteger(y) ||
      typeof z !== "number" || !Number.isInteger(z) ||
      typeof type !== "string" || !type
    ) {
      throw new Error("Build contains invalid collision data");
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    hasWaterBlocks ||= type === "water";

    if ((i + 1) % YIELD_EVERY_BLOCKS === 0) {
      opts?.onProgress?.({ processedBlocks: i + 1, totalBlocks: blockCount * 2 });
      throwIfAborted(opts?.signal);
      await yieldToMainThread();
    }
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const depth = maxZ - minZ + 1;
  if (
    width > MAX_COLLISION_AXIS ||
    height > MAX_COLLISION_AXIS ||
    depth > MAX_COLLISION_AXIS
  ) {
    throw new Error("Build collision bounds exceed the supported grid");
  }

  const chunkCountX = Math.ceil(width / COLLISION_CHUNK_SIZE);
  const chunkCountZ = Math.ceil(depth / COLLISION_CHUNK_SIZE);
  const solids = new Map<number, Uint8Array>();
  const water = hasWaterBlocks ? new Map<number, Uint8Array>() : null;
  const chunkKey = (x: number, y: number, z: number) =>
    (x >> COLLISION_CHUNK_BITS) +
    chunkCountX * ((z >> COLLISION_CHUNK_BITS) + chunkCountZ * (y >> COLLISION_CHUNK_BITS));
  const cellBit = (x: number, y: number, z: number) =>
    (x & COLLISION_CHUNK_MASK) +
    COLLISION_CHUNK_SIZE *
      ((z & COLLISION_CHUNK_MASK) + COLLISION_CHUNK_SIZE * (y & COLLISION_CHUNK_MASK));

  for (let i = 0; i < blockCount; i += 1) {
    const block = packed ? null : build.blocks[i];
    const x = (packed ? packed.positions[i * 3] : block!.x) - minX;
    const y = (packed ? packed.positions[i * 3 + 1] : block!.y) - minY;
    const z = (packed ? packed.positions[i * 3 + 2] : block!.z) - minZ;
    const type = packed ? packed.typeNames[packed.typeIds[i]] : block!.type;
    if (type === "water" && water) {
      setBit(getChunk(water, chunkKey(x, y, z)), cellBit(x, y, z));
    } else if (type !== "lava") {
      setBit(getChunk(solids, chunkKey(x, y, z)), cellBit(x, y, z));
    }

    if ((i + 1) % YIELD_EVERY_BLOCKS === 0) {
      opts?.onProgress?.({
        processedBlocks: blockCount + i + 1,
        totalBlocks: blockCount * 2,
      });
      throwIfAborted(opts?.signal);
      await yieldToMainThread();
    }
  }
  throwIfAborted(opts?.signal);
  opts?.onProgress?.({ processedBlocks: blockCount * 2, totalBlocks: blockCount * 2 });

  // Meshes are centered on X/Z and shifted to minY, so collision and spawn use
  // the same local world instead of raw build coordinates.
  const worldMinX = -width / 2;
  const worldMinZ = -depth / 2;

  const intersects = (position: ExplorerPosition, chunks: Map<number, Uint8Array> | null): boolean => {
    if (!chunks) return false;
    const feetY = position.y - EXPLORER_EYE_HEIGHT;
    const minCellX = Math.floor(position.x - PLAYER_HALF_WIDTH - worldMinX + COLLISION_EPSILON);
    const maxCellX = Math.floor(position.x + PLAYER_HALF_WIDTH - worldMinX - COLLISION_EPSILON);
    const minCellY = Math.floor(feetY + COLLISION_EPSILON);
    const maxCellY = Math.floor(feetY + EXPLORER_PLAYER_HEIGHT - COLLISION_EPSILON);
    const minCellZ = Math.floor(position.z - PLAYER_HALF_WIDTH - worldMinZ + COLLISION_EPSILON);
    const maxCellZ = Math.floor(position.z + PLAYER_HALF_WIDTH - worldMinZ - COLLISION_EPSILON);

    if (
      maxCellX < 0 || minCellX >= width ||
      maxCellY < 0 || minCellY >= height ||
      maxCellZ < 0 || minCellZ >= depth
    ) {
      return false;
    }

    for (let y = Math.max(0, minCellY); y <= Math.min(height - 1, maxCellY); y += 1) {
      for (let z = Math.max(0, minCellZ); z <= Math.min(depth - 1, maxCellZ); z += 1) {
        for (let x = Math.max(0, minCellX); x <= Math.min(width - 1, maxCellX); x += 1) {
          if (hasBit(chunks.get(chunkKey(x, y, z)) ?? null, cellBit(x, y, z))) return true;
        }
      }
    }
    return false;
  };

  const topAtCenterColumn = () => {
    const x = Math.floor(-worldMinX);
    const z = Math.floor(-worldMinZ);
    if (x < 0 || x >= width || z < 0 || z >= depth) return null;
    for (let y = height - 1; y >= 0; y -= 1) {
      const key = chunkKey(x, y, z);
      const bit = cellBit(x, y, z);
      if (hasBit(solids.get(key) ?? null, bit) || hasBit(water?.get(key) ?? null, bit)) return y + 1;
    }
    return null;
  };
  const centerTop = topAtCenterColumn();

  return {
    height,
    spawnPosition: {
      x: 0,
      y: (centerTop ?? 2) + EXPLORER_EYE_HEIGHT + SPAWN_CLEARANCE,
      z: 0,
    },
    collides(position) {
      const feetY = position.y - EXPLORER_EYE_HEIGHT;
      return feetY < -COLLISION_EPSILON || intersects(position, solids);
    },
    isInWater(position) {
      return intersects(position, water);
    },
  };
}

export function moveExplorerPlayerAxis(
  world: ExplorerCollisionWorld,
  position: ExplorerPosition,
  axis: ExplorerAxis,
  distance: number,
): boolean {
  if (!Number.isFinite(distance) || distance === 0) return false;
  const start = position[axis];
  position[axis] = start + distance;
  if (!world.collides(position)) return false;

  position[axis] = start;
  if (world.collides(position)) return true;

  let clear = 0;
  let blocked = 1;
  for (let i = 0; i < 12; i += 1) {
    const fraction = (clear + blocked) / 2;
    position[axis] = start + distance * fraction;
    if (world.collides(position)) blocked = fraction;
    else clear = fraction;
  }
  position[axis] = start + distance * clear;
  return true;
}
