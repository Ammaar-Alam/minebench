import { getRenderKind } from "@/lib/blocks/registry";
import type { VoxelBuild } from "@/lib/voxel/types";

const FACE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function encodePosition(x: number, y: number, z: number): number {
  return (x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20);
}

export function isVoxelOccluder(blockType: string): boolean {
  const kind = getRenderKind(blockType) ?? "opaque";
  return kind === "opaque" || kind === "emissive";
}

export function canVoxelBlockEmitAnyFace(
  block: VoxelBuild["blocks"][number],
  blocksByPos: ReadonlyMap<number, string>,
): boolean {
  for (const [dx, dy, dz] of FACE_OFFSETS) {
    const neighborType = blocksByPos.get(encodePosition(block.x + dx, block.y + dy, block.z + dz));
    if (!neighborType) return true;
    if (neighborType === block.type) continue;
    if (isVoxelOccluder(neighborType)) continue;
    return true;
  }

  return false;
}

export function filterRenderableVoxelBuild(build: VoxelBuild): VoxelBuild {
  if (build.blocks.length <= 0) return build;

  const blocksByPos = new Map<number, string>();
  for (const block of build.blocks) {
    blocksByPos.set(encodePosition(block.x, block.y, block.z), block.type);
  }

  const visibleBlocks = build.blocks.filter((block) => canVoxelBlockEmitAnyFace(block, blocksByPos));
  if (visibleBlocks.length === build.blocks.length) return build;

  return {
    version: "1.0",
    blocks: visibleBlocks,
  };
}
