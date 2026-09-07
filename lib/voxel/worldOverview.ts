import { encodeBinaryVoxelBuild } from "@/lib/voxel/binaryBuild";
import { createPackedVoxelBlocks } from "@/lib/voxel/packedBlocks";
import { isVoxelOccluder } from "@/lib/voxel/renderVisibility";
import type {
  MixedVoxelWorldRegion,
  VoxelWorldRegion as EvaluatedVoxelWorldRegion,
} from "@/lib/voxel/worldRegions";

export const VOXEL_WORLD_OVERVIEW_SCALE = 32;

export type VoxelWorldOverviewState = {
  cellsPerAxis: number;
  materials: Uint8Array | Uint16Array;
};

export function createVoxelWorldOverviewState(
  gridSize: number,
  paletteSize: number,
): VoxelWorldOverviewState | null {
  if (gridSize <= 512) return null;
  const cellsPerAxis = gridSize / VOXEL_WORLD_OVERVIEW_SCALE;
  if (!Number.isInteger(cellsPerAxis) || cellsPerAxis < 1 || cellsPerAxis > 256) return null;
  return {
    cellsPerAxis,
    materials: paletteSize <= 255
      ? new Uint8Array(cellsPerAxis ** 3)
      : new Uint16Array(cellsPerAxis ** 3),
  };
}

function overviewIndex(cellsPerAxis: number, x: number, y: number, z: number): number {
  return x + y * cellsPerAxis + z * cellsPerAxis * cellsPerAxis;
}

export function markUniformVoxelWorldOverviewRegion(
  overview: VoxelWorldOverviewState,
  region: Extract<EvaluatedVoxelWorldRegion, { kind: "uniform" }>,
  material: number,
): void {
  const max = overview.cellsPerAxis - 1;
  const x1 = Math.max(0, Math.min(max, Math.floor(region.origin.x / VOXEL_WORLD_OVERVIEW_SCALE)));
  const y1 = Math.max(0, Math.min(max, Math.floor(region.origin.y / VOXEL_WORLD_OVERVIEW_SCALE)));
  const z1 = Math.max(0, Math.min(max, Math.floor(region.origin.z / VOXEL_WORLD_OVERVIEW_SCALE)));
  const x2 = Math.max(0, Math.min(max, Math.floor((region.origin.x + region.size.x - 1) / VOXEL_WORLD_OVERVIEW_SCALE)));
  const y2 = Math.max(0, Math.min(max, Math.floor((region.origin.y + region.size.y - 1) / VOXEL_WORLD_OVERVIEW_SCALE)));
  const z2 = Math.max(0, Math.min(max, Math.floor((region.origin.z + region.size.z - 1) / VOXEL_WORLD_OVERVIEW_SCALE)));
  for (let z = z1; z <= z2; z += 1) {
    for (let y = y1; y <= y2; y += 1) {
      const start = overviewIndex(overview.cellsPerAxis, x1, y, z);
      overview.materials.fill(material, start, start + x2 - x1 + 1);
    }
  }
}

export function markMixedVoxelWorldOverviewRegion(
  overview: VoxelWorldOverviewState,
  region: MixedVoxelWorldRegion,
): void {
  const sx = region.size.x;
  const sy = region.size.y;
  const plane = sx * sy;
  for (let index = 0; index < region.materialIndexes.length; index += 1) {
    const material = region.materialIndexes[index]!;
    if (material === 0) continue;
    const x = region.origin.x + (index % sx);
    const y = region.origin.y + (Math.floor(index / sx) % sy);
    const z = region.origin.z + Math.floor(index / plane);
    overview.materials[overviewIndex(
      overview.cellsPerAxis,
      Math.floor(x / VOXEL_WORLD_OVERVIEW_SCALE),
      Math.floor(y / VOXEL_WORLD_OVERVIEW_SCALE),
      Math.floor(z / VOXEL_WORLD_OVERVIEW_SCALE),
    )] = material;
  }
}

function canOverviewCellEmitAnyFace(
  materials: Uint8Array | Uint16Array,
  occluders: Uint8Array,
  cellsPerAxis: number,
  x: number,
  y: number,
  z: number,
): boolean {
  const material = materials[overviewIndex(cellsPerAxis, x, y, z)]!;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (nx < 0 || ny < 0 || nz < 0 || nx >= cellsPerAxis || ny >= cellsPerAxis || nz >= cellsPerAxis) return true;
    const neighbor = materials[overviewIndex(cellsPerAxis, nx, ny, nz)]!;
    if (neighbor === 0) return true;
    if (neighbor === material) continue;
    if (occluders[neighbor]) continue;
    return true;
  }
  return false;
}

export function encodeVoxelWorldOverviewBuild(
  overview: VoxelWorldOverviewState,
  paletteIds: string[],
  sourceBuildSha256: string,
): { bytes: Uint8Array; blockCount: number } {
  const occluders = Uint8Array.from([0, ...paletteIds.map((type) => isVoxelOccluder(type) ? 1 : 0)]);
  const { cellsPerAxis, materials } = overview;
  let blockCount = 0;
  for (let z = 0; z < cellsPerAxis; z += 1) {
    for (let y = 0; y < cellsPerAxis; y += 1) {
      for (let x = 0; x < cellsPerAxis; x += 1) {
        if (materials[overviewIndex(cellsPerAxis, x, y, z)] && canOverviewCellEmitAnyFace(materials, occluders, cellsPerAxis, x, y, z)) {
          blockCount += 1;
        }
      }
    }
  }

  const packed = createPackedVoxelBlocks(blockCount);
  packed.typeNames = paletteIds.slice();
  for (let z = 0; z < cellsPerAxis; z += 1) {
    for (let y = 0; y < cellsPerAxis; y += 1) {
      for (let x = 0; x < cellsPerAxis; x += 1) {
        const material = materials[overviewIndex(cellsPerAxis, x, y, z)]!;
        if (material === 0 || !canOverviewCellEmitAnyFace(materials, occluders, cellsPerAxis, x, y, z)) continue;
        const write = packed.count;
        packed.positions[write * 3] = x;
        packed.positions[write * 3 + 1] = y;
        packed.positions[write * 3 + 2] = z;
        packed.typeIds[write] = material - 1;
        packed.count += 1;
      }
    }
  }

  return { bytes: encodeBinaryVoxelBuild(packed, sourceBuildSha256), blockCount };
}
