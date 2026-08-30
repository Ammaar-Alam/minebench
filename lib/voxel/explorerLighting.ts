import * as THREE from "three";
import { getRenderKind } from "@/lib/blocks/registry";
import {
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";

const BLOCK_LIGHT_MAX_LEVEL = 15;
const BLOCK_LIGHT_OCCLUDER = 0x80;
const BLOCK_LIGHT_SOURCE = 0x40;
const BLOCK_LIGHT_PADDING = BLOCK_LIGHT_MAX_LEVEL;
const BLOCK_LIGHT_BYTE_SCALE = 255 / BLOCK_LIGHT_MAX_LEVEL;
const MAX_BLOCK_LIGHT_CELLS = 32_000_000;
const QUEUE_CHUNK_SIZE = 65_536;
const YIELD_EVERY = 262_144;

export type ExplorerBlockLightGrid = {
  cells: Uint8Array;
  width: number;
  height: number;
  depth: number;
  minX: number;
  minY: number;
  minZ: number;
  padding: number;
};

type ExplorerLightingOptions = {
  signal?: AbortSignal;
  onProgress?: (stage: string) => void;
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function yieldToMainThread(signal?: AbortSignal) {
  throwIfAborted(signal);
  const schedulerApi = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof schedulerApi?.yield === "function") await schedulerApi.yield();
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

function blockFlags(type: string): number {
  return (
    (isVoxelOccluder(type) ? BLOCK_LIGHT_OCCLUDER : 0) |
    (getRenderKind(type) === "emissive" ? BLOCK_LIGHT_SOURCE : 0)
  );
}

export async function createExplorerBlockLightGrid(
  build: RenderableVoxelBuild,
  opts?: ExplorerLightingOptions,
): Promise<ExplorerBlockLightGrid | null> {
  const blockCount = voxelBuildBlockCount(build);
  if (blockCount === 0) return null;

  const packed = build.packed;
  const packedFlags = packed ? Uint8Array.from(packed.typeNames, blockFlags) : null;
  const objectFlags = new Map<string, number>();
  const flagsFor = (type: string) => {
    const cached = objectFlags.get(type);
    if (cached !== undefined) return cached;
    const flags = blockFlags(type);
    objectFlags.set(type, flags);
    return flags;
  };

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let sourceCount = 0;

  for (let i = 0; i < blockCount; i += 1) {
    const block = packed ? null : build.blocks[i];
    const x = packed ? packed.positions[i * 3] : block!.x;
    const y = packed ? packed.positions[i * 3 + 1] : block!.y;
    const z = packed ? packed.positions[i * 3 + 2] : block!.z;
    const flags = packed ? packedFlags?.[packed.typeIds[i]] ?? 0 : flagsFor(block!.type);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    if ((flags & BLOCK_LIGHT_SOURCE) !== 0) sourceCount += 1;
    if ((i + 1) % YIELD_EVERY === 0) await yieldToMainThread(opts?.signal);
  }
  if (sourceCount === 0) return null;

  const buildWidth = maxX - minX + 1;
  const buildHeight = maxY - minY + 1;
  const buildDepth = maxZ - minZ + 1;
  let padding = BLOCK_LIGHT_PADDING;
  while (
    padding > 1 &&
    (buildWidth + padding * 2) *
      (buildHeight + padding * 2) *
      (buildDepth + padding * 2) > MAX_BLOCK_LIGHT_CELLS
  ) {
    padding -= 1;
  }
  const width = buildWidth + padding * 2;
  const height = buildHeight + padding * 2;
  const depth = buildDepth + padding * 2;
  const cells = new Uint8Array(width * height * depth);
  const plane = width * depth;
  const queue: Array<Uint32Array | null> = [new Uint32Array(QUEUE_CHUNK_SIZE)];
  let readChunk = 0;
  let readOffset = 0;
  let writeChunk = 0;
  let writeOffset = 0;
  let queued = 0;
  const enqueue = (index: number) => {
    if (writeOffset === QUEUE_CHUNK_SIZE) {
      writeChunk += 1;
      writeOffset = 0;
      queue.push(new Uint32Array(QUEUE_CHUNK_SIZE));
    }
    (queue[writeChunk] as Uint32Array)[writeOffset] = index;
    writeOffset += 1;
    queued += 1;
  };
  const dequeue = () => {
    if (queued === 0) return -1;
    const index = (queue[readChunk] as Uint32Array)[readOffset];
    readOffset += 1;
    queued -= 1;
    if (readOffset === QUEUE_CHUNK_SIZE) {
      queue[readChunk] = null;
      readChunk += 1;
      readOffset = 0;
    }
    return index;
  };
  const spread = (neighbor: number, nextLevel: number) => {
    const cell = cells[neighbor];
    if ((cell & BLOCK_LIGHT_OCCLUDER) !== 0 || (cell & BLOCK_LIGHT_MAX_LEVEL) >= nextLevel) {
      return;
    }
    cells[neighbor] = nextLevel;
    enqueue(neighbor);
  };

  opts?.onProgress?.("Lighting glowstone");
  for (let i = 0; i < blockCount; i += 1) {
    const block = packed ? null : build.blocks[i];
    const x = packed ? packed.positions[i * 3] : block!.x;
    const y = packed ? packed.positions[i * 3 + 1] : block!.y;
    const z = packed ? packed.positions[i * 3 + 2] : block!.z;
    const flags = packed ? packedFlags?.[packed.typeIds[i]] ?? 0 : flagsFor(block!.type);
    const index =
      x - minX + padding +
      width * (z - minZ + padding + depth * (y - minY + padding));
    if ((flags & BLOCK_LIGHT_OCCLUDER) !== 0) cells[index] |= BLOCK_LIGHT_OCCLUDER;
    if ((flags & BLOCK_LIGHT_SOURCE) !== 0 && (cells[index] & BLOCK_LIGHT_MAX_LEVEL) === 0) {
      cells[index] |= BLOCK_LIGHT_MAX_LEVEL;
      enqueue(index);
    }
    if ((i + 1) % YIELD_EVERY === 0) await yieldToMainThread(opts?.signal);
  }

  let processed = 0;
  while (queued > 0) {
    const index = dequeue();
    const nextLevel = (cells[index] & BLOCK_LIGHT_MAX_LEVEL) - 1;
    if (nextLevel > 0) {
      const y = Math.floor(index / plane);
      const remainder = index - y * plane;
      const z = Math.floor(remainder / width);
      const x = remainder - z * width;
      if (x > 0) spread(index - 1, nextLevel);
      if (x + 1 < width) spread(index + 1, nextLevel);
      if (z > 0) spread(index - width, nextLevel);
      if (z + 1 < depth) spread(index + width, nextLevel);
      if (y > 0) spread(index - plane, nextLevel);
      if (y + 1 < height) spread(index + plane, nextLevel);
    }
    processed += 1;
    if (processed % YIELD_EVERY === 0) await yieldToMainThread(opts?.signal);
  }

  return {
    cells,
    width,
    height,
    depth,
    minX: minX - padding,
    minY: minY - padding,
    minZ: minZ - padding,
    padding,
  };
}

export function getExplorerBlockLight(
  grid: ExplorerBlockLightGrid,
  x: number,
  y: number,
  z: number,
): number {
  const localX = x - grid.minX;
  const localY = y - grid.minY;
  const localZ = z - grid.minZ;
  if (
    localX < 0 || localX >= grid.width ||
    localY < 0 || localY >= grid.height ||
    localZ < 0 || localZ >= grid.depth
  ) {
    return 0;
  }
  return grid.cells[localX + grid.width * (localZ + grid.depth * localY)] & BLOCK_LIGHT_MAX_LEVEL;
}

function enableExplorerBlockLight(material: THREE.MeshLambertMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <color_pars_vertex>",
        "#include <color_pars_vertex>\nattribute float explorerBlockLight;\nvarying float vExplorerBlockLight;",
      )
      .replace(
        "#include <color_vertex>",
        "#include <color_vertex>\nvExplorerBlockLight = explorerBlockLight;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <color_pars_fragment>",
        "#include <color_pars_fragment>\nvarying float vExplorerBlockLight;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.62, 0.32) * pow(vExplorerBlockLight, 1.6) * 1.2;",
      );
  };
  material.customProgramCacheKey = () => "explorer-block-light-v1";
  material.needsUpdate = true;
}

export async function applyExplorerBlockLighting(
  root: THREE.Object3D,
  bounds: THREE.Box3,
  grid: ExplorerBlockLightGrid,
  opts?: ExplorerLightingOptions,
): Promise<void> {
  const meshes: Array<THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>> = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshLambertMaterial) {
      meshes.push(child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>);
    }
  });
  if (meshes.length === 0) return;

  opts?.onProgress?.("Applying glowstone light");
  const worldMinX = bounds.min.x - grid.padding;
  const worldMinY = bounds.min.y - grid.padding;
  const worldMinZ = bounds.min.z - grid.padding;
  const { cells, width, height, depth } = grid;
  const plane = width * depth;
  let processed = 0;

  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute("position");
    const normals = mesh.geometry.getAttribute("normal");
    if (!positions || !normals || positions.itemSize !== 3 || normals.itemSize !== 3) continue;
    const positionArray = positions.array;
    const normalArray = normals.array;
    const values = new Uint8Array(positions.count);

    for (let vertex = 0; vertex + 3 < positions.count; vertex += 4) {
      const offset = vertex * 3;
      const normalX = Math.sign(normalArray[offset]);
      const normalY = Math.sign(normalArray[offset + 1]);
      const normalZ = Math.sign(normalArray[offset + 2]);
      const sampleOffsetX = normalX === 0 ? -0.001 : normalX * 0.01;
      const sampleOffsetY = normalY === 0 ? -0.001 : normalY * 0.01;
      const sampleOffsetZ = normalZ === 0 ? -0.001 : normalZ * 0.01;

      for (let corner = 0; corner < 4; corner += 1) {
        const cornerOffset = offset + corner * 3;
        const x = Math.floor(positionArray[cornerOffset] + sampleOffsetX - worldMinX);
        const y = Math.floor(positionArray[cornerOffset + 1] + sampleOffsetY - worldMinY);
        const z = Math.floor(positionArray[cornerOffset + 2] + sampleOffsetZ - worldMinZ);
        const level =
          x >= 0 && x < width &&
          y >= 0 && y < height &&
          z >= 0 && z < depth
            ? cells[x + width * z + plane * y] & BLOCK_LIGHT_MAX_LEVEL
            : 0;
        values[vertex + corner] = level * BLOCK_LIGHT_BYTE_SCALE;
      }
      processed += 4;
      if (processed % YIELD_EVERY === 0) await yieldToMainThread(opts?.signal);
    }

    mesh.geometry.setAttribute(
      "explorerBlockLight",
      new THREE.Uint8BufferAttribute(values, 1, true),
    );
    enableExplorerBlockLight(mesh.material);
  }
}

export function renderExplorerBloomOverlay(
  renderer: { autoClear: boolean },
  render: () => void,
): void {
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    render();
  } finally {
    renderer.autoClear = autoClear;
  }
}

export function isExplorerSunRayVisible(
  x: number,
  y: number,
  z: number,
  margin = 1.2,
): boolean {
  return (
    [x, y, z, margin].every(Number.isFinite) &&
    margin > 0 &&
    Math.abs(x) <= margin &&
    Math.abs(y) <= margin &&
    z >= -1 &&
    z <= 1
  );
}
