// Shared generation limits (used by both raw JSON and tool-assisted paths).

export type GridSize = 64 | 256 | 512;

// 75% of grid volume — with primitives (boxes/lines) we can handle much larger builds efficiently
export const MAX_BLOCKS_BY_GRID: Record<GridSize, number> = {
  64: Math.floor(64 ** 3 * 0.75), // 196,608
  // Cap higher grids to keep validation/rendering practical.
  256: 2_000_000,
  512: 4_000_000,
};

export const MIN_BLOCKS_BY_GRID: Record<GridSize, number> = {
  64: 200,
  256: 500,
  512: 800,
};

export function maxBlocksForGrid(gridSize: GridSize) {
  return MAX_BLOCKS_BY_GRID[gridSize];
}

export function minBlocksForGrid(gridSize: GridSize) {
  return MIN_BLOCKS_BY_GRID[gridSize];
}

