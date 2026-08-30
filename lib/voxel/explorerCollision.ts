import {
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";

export const EXPLORER_PLAYER_WIDTH = 0.6;
export const EXPLORER_PLAYER_HEIGHT = 1.8;
export const EXPLORER_EYE_HEIGHT = 1.62;

const PLAYER_HALF_WIDTH = EXPLORER_PLAYER_WIDTH / 2;
const MAX_COLLISION_AXIS = 512;
const COLLISION_EPSILON = 1e-5;
const YIELD_EVERY_BLOCKS = 262_144;

export type ExplorerPosition = { x: number; y: number; z: number };
export type ExplorerAxis = "x" | "y" | "z";

export type ExplorerCollisionWorld = {
  height: number;
  collides: (position: ExplorerPosition) => boolean;
  isInWater: (position: ExplorerPosition) => boolean;
};

type BuildProgress = {
  processedBlocks: number;
  totalBlocks: number;
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

function setBit(bits: Uint8Array, index: number) {
  bits[index >>> 3] |= 1 << (index & 7);
}

function hasBit(bits: Uint8Array | null, index: number): boolean {
  return Boolean(bits && (bits[index >>> 3] & (1 << (index & 7))));
}

export async function createExplorerCollisionWorld(
  build: RenderableVoxelBuild,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (progress: BuildProgress) => void;
  },
): Promise<ExplorerCollisionWorld> {
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

  const cellCount = width * height * depth;
  const byteCount = Math.ceil(cellCount / 8);
  const solids = new Uint8Array(byteCount);
  const water = hasWaterBlocks ? new Uint8Array(byteCount) : null;

  for (let i = 0; i < blockCount; i += 1) {
    const block = packed ? null : build.blocks[i];
    const x = (packed ? packed.positions[i * 3] : block?.x) as number;
    const y = (packed ? packed.positions[i * 3 + 1] : block?.y) as number;
    const z = (packed ? packed.positions[i * 3 + 2] : block?.z) as number;
    const type = packed ? packed.typeNames[packed.typeIds[i]] : block?.type;
    const index = x - minX + width * (z - minZ + depth * (y - minY));
    if (type === "water") setBit(water as Uint8Array, index);
    else if (type !== "lava") setBit(solids, index);

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

  const worldMinX = -width / 2;
  const worldMinZ = -depth / 2;

  const intersects = (position: ExplorerPosition, bits: Uint8Array | null): boolean => {
    if (!bits) return false;
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
          if (hasBit(bits, x + width * (z + depth * y))) return true;
        }
      }
    }
    return false;
  };

  return {
    height,
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
