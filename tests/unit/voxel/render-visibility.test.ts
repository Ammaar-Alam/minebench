import assert from "node:assert/strict";
import { filterRenderableVoxelBuild } from "../../../lib/voxel/renderVisibility";
import type { VoxelBlock } from "../../../lib/voxel/types";

const target: VoxelBlock = { x: 8191, y: 1, z: 1, type: "stone" };
const filtered = filterRenderableVoxelBuild({
  version: "1.0",
  blocks: [
    target,
    { x: 8190, y: 1, z: 1, type: "stone" },
    { x: 8191, y: 0, z: 1, type: "stone" },
    { x: 8191, y: 2, z: 1, type: "stone" },
    { x: 8191, y: 1, z: 0, type: "stone" },
    { x: 8191, y: 1, z: 2, type: "stone" },
    { x: 0, y: 1, z: 1, type: "stone" },
  ],
});

assert.ok(
  filtered.blocks.some((block) => block.x === target.x && block.y === target.y && block.z === target.z),
  "edge blocks must not treat the out-of-bounds neighbor as an aliased in-bounds block",
);

console.log("render visibility coordinate checks passed");
