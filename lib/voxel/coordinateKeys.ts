export const MAX_VOXEL_COORDINATE = 8191;

const POSITION_KEY_OFFSET = 1;
const POSITION_KEY_RADIX = MAX_VOXEL_COORDINATE + 3;
const PLANE_CELL_RADIX = MAX_VOXEL_COORDINATE + 1;

export function isVoxelCoordinateInRange(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_VOXEL_COORDINATE;
}

export function encodeVoxelPositionKey(x: number, y: number, z: number): number {
  // Three 13-bit axes exceed 32-bit bitwise storage. The radix covers
  // -1..8192 neighbor probes, and the final key stays below 2^53.
  return (x + POSITION_KEY_OFFSET) +
    (y + POSITION_KEY_OFFSET) * POSITION_KEY_RADIX +
    (z + POSITION_KEY_OFFSET) * POSITION_KEY_RADIX * POSITION_KEY_RADIX;
}

export function decodeVoxelPositionKey(value: number): [number, number, number] {
  const x = (value % POSITION_KEY_RADIX) - POSITION_KEY_OFFSET;
  const y = (Math.floor(value / POSITION_KEY_RADIX) % POSITION_KEY_RADIX) - POSITION_KEY_OFFSET;
  const z = Math.floor(value / (POSITION_KEY_RADIX * POSITION_KEY_RADIX)) - POSITION_KEY_OFFSET;
  return [x, y, z];
}

export function hashVoxelPositionKey(x: number, y: number, z: number): number {
  const h =
    Math.imul(x + 1, 73856093) ^
    Math.imul(y + 1, 19349663) ^
    Math.imul(z + 1, 83492791);
  return (h ^ (h >>> 16)) >>> 0;
}

export function packVoxelPlaneCell(u: number, v: number): number {
  return u + v * PLANE_CELL_RADIX;
}

export function unpackVoxelPlaneCellU(value: number): number {
  return value % PLANE_CELL_RADIX;
}

export function unpackVoxelPlaneCellV(value: number): number {
  return Math.floor(value / PLANE_CELL_RADIX);
}
