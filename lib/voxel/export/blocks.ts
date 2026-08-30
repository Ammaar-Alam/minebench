import type { BlockDefinition } from "@/lib/blocks/palettes";
import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";

export function collectVoxelExportBlocks(build: VoxelBuild, palette: BlockDefinition[]) {
  const allowed = new Set(palette.map((block) => block.id));
  const blocksByPosition = new Map<string, VoxelBlock>();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const block of build.blocks) {
    if (!allowed.has(block.type)) continue;
    blocksByPosition.set(`${block.x},${block.y},${block.z}`, block);
    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
    minZ = Math.min(minZ, block.z);
    maxX = Math.max(maxX, block.x);
    maxY = Math.max(maxY, block.y);
    maxZ = Math.max(maxZ, block.z);
  }

  const blocks = Array.from(blocksByPosition.values());
  if (blocks.length === 0) throw new Error("No blocks to export");
  return {
    blocks,
    min: [minX, minY, minZ] as const,
    max: [maxX, maxY, maxZ] as const,
    size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1] as const,
  };
}
