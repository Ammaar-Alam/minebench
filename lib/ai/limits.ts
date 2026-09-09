// Shared generation limits (used by both raw JSON and tool-assisted paths).
// Use the full grid volume as the ceiling for final builds: after validation and
// dedupe, there can be at most one block per occupied cell.

export const GRID_SIZES = [32, 64, 256, 512, 2048, 8192] as const;
export type GridSize = (typeof GRID_SIZES)[number];

export function isGridSize(value: unknown): value is GridSize {
  return GRID_SIZES.some((size) => size === value);
}

export const MAX_GENERATION_PROMPT_CHARS = 800;

export const MAX_BLOCKS_BY_GRID: Record<GridSize, number> = {
  32: 32 ** 3,
  64: 64 ** 3,
  256: 256 ** 3,
  512: 512 ** 3,
  2048: 2048 ** 3,
  8192: 8192 ** 3,
};

export const MIN_BLOCKS_BY_GRID: Record<GridSize, number> = {
  32: 80,
  64: 200,
  256: 500,
  512: 800,
  2048: 800,
  8192: 800,
};

export function maxBlocksForGrid(gridSize: GridSize) {
  return MAX_BLOCKS_BY_GRID[gridSize];
}

export function minBlocksForGrid(gridSize: GridSize) {
  return MIN_BLOCKS_BY_GRID[gridSize];
}
