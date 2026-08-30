import assert from "node:assert/strict";
import {
  EXPLORER_EYE_HEIGHT,
  createExplorerCollisionWorld,
  moveExplorerPlayerAxis,
  setExplorerMoveDirection,
} from "@/lib/voxel/explorerCollision";
import {
  packVoxelBlocks,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";

const build: RenderableVoxelBuild = {
  version: "1.0",
  blocks: [
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "water" },
    { x: 2, y: 0, z: 0, type: "lava" },
  ],
};

async function main() {
  const movement = { x: 0, y: 0, z: 0 };
  const pitchedForward = { x: 0, y: 0.6, z: -0.8 };
  setExplorerMoveDirection(movement, pitchedForward, { x: 1, y: 0, z: 0 }, 1, 0, 0);
  assert.deepEqual(movement, pitchedForward);

  setExplorerMoveDirection(movement, pitchedForward, { x: 1, y: 0, z: 0 }, 1, 0, 1);
  assert.ok(Math.abs(Math.hypot(movement.x, movement.y, movement.z) - 1) < 1e-12);
  assert.ok(movement.y > pitchedForward.y);

  const world = await createExplorerCollisionWorld(build);

  assert.equal(world.collides({ x: -1, y: EXPLORER_EYE_HEIGHT, z: 0 }), true);
  assert.equal(world.collides({ x: 0, y: EXPLORER_EYE_HEIGHT, z: 0 }), false);
  assert.equal(world.isInWater({ x: 0, y: EXPLORER_EYE_HEIGHT, z: 0 }), true);
  assert.equal(world.collides({ x: 1, y: EXPLORER_EYE_HEIGHT, z: 0 }), false);
  assert.equal(world.collides({ x: 3, y: EXPLORER_EYE_HEIGHT - 0.01, z: 0 }), true);

  const packedWorld = await createExplorerCollisionWorld({
    version: "1.0",
    blocks: [],
    packed: packVoxelBlocks(build.blocks),
  });
  assert.equal(packedWorld.collides({ x: -1, y: EXPLORER_EYE_HEIGHT, z: 0 }), true);
  assert.equal(packedWorld.isInWater({ x: 0, y: EXPLORER_EYE_HEIGHT, z: 0 }), true);

  const falling = { x: 3, y: EXPLORER_EYE_HEIGHT + 1, z: 0 };
  assert.equal(moveExplorerPlayerAxis(world, falling, "y", -2), true);
  assert.ok(Math.abs(falling.y - EXPLORER_EYE_HEIGHT) < 0.001);

  const embedded = { x: -1, y: EXPLORER_EYE_HEIGHT, z: 0 };
  assert.equal(moveExplorerPlayerAxis(world, embedded, "x", 0.2), true);
  assert.equal(embedded.x, -1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
