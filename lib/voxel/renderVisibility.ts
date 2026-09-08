import { getRenderKind } from "@/lib/blocks/registry";
import { computeVisibleFaceMask, SpatialBlockTable } from "@/lib/voxel/ambientOcclusion";
import { createPackedVoxelBlocks, type RenderableVoxelBuild } from "@/lib/voxel/packedBlocks";
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

function packedVisibilityContext(packed: NonNullable<RenderableVoxelBuild["packed"]>) {
  const table = new SpatialBlockTable(packed.count);
  const materialOccluding = new Uint8Array(packed.typeNames.length);
  for (let typeId = 0; typeId < packed.typeNames.length; typeId += 1) {
    materialOccluding[typeId] = isVoxelOccluder(packed.typeNames[typeId] ?? "") ? 1 : 0;
  }
  for (let index = 0; index < packed.count; index += 1) {
    table.set(
      packed.positions[index * 3]!,
      packed.positions[index * 3 + 1]!,
      packed.positions[index * 3 + 2]!,
      packed.typeIds[index]!,
    );
  }
  return { table, materialOccluding };
}

function packedBlockIsRenderable(
  packed: NonNullable<RenderableVoxelBuild["packed"]>,
  index: number,
  context: ReturnType<typeof packedVisibilityContext>,
): boolean {
  return computeVisibleFaceMask(
    packed.positions[index * 3]!,
    packed.positions[index * 3 + 1]!,
    packed.positions[index * 3 + 2]!,
    packed.typeIds[index]!,
    context.table,
    context.materialOccluding,
  ) !== 0;
}

function filterPackedRenderableVoxelBuild(build: RenderableVoxelBuild): RenderableVoxelBuild {
  const packed = build.packed;
  if (!packed || packed.count <= 0) return build;

  const context = packedVisibilityContext(packed);
  let visibleCount = 0;
  for (let index = 0; index < packed.count; index += 1) {
    if (packedBlockIsRenderable(packed, index, context)) visibleCount += 1;
  }
  if (visibleCount === packed.count) return build;

  const visible = createPackedVoxelBlocks(visibleCount);
  visible.typeNames = packed.typeNames.slice();
  let write = 0;
  for (let index = 0; index < packed.count; index += 1) {
    if (!packedBlockIsRenderable(packed, index, context)) continue;
    visible.positions[write * 3] = packed.positions[index * 3]!;
    visible.positions[write * 3 + 1] = packed.positions[index * 3 + 1]!;
    visible.positions[write * 3 + 2] = packed.positions[index * 3 + 2]!;
    visible.typeIds[write] = packed.typeIds[index]!;
    write += 1;
  }
  visible.count = write;

  return {
    version: "1.0",
    blocks: [],
    packed: visible,
  };
}

export function filterRenderableVoxelBuild(build: VoxelBuild): VoxelBuild;
export function filterRenderableVoxelBuild(build: RenderableVoxelBuild): RenderableVoxelBuild;
export function filterRenderableVoxelBuild(build: RenderableVoxelBuild): RenderableVoxelBuild {
  if (build.packed) return filterPackedRenderableVoxelBuild(build);
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
