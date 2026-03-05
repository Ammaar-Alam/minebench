// Shared generation limits (used by both raw JSON and tool-assisted paths).
// Use the full grid volume as the ceiling for final builds: after validation and
// dedupe, there can be at most one block per occupied cell.

export type GridSize = 64 | 256 | 512;

export const MAX_BLOCKS_BY_GRID: Record<GridSize, number> = {
  64: 64 ** 3,
  256: 256 ** 3,
  512: 512 ** 3,
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
