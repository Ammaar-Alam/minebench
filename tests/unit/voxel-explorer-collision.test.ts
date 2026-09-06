import assert from "node:assert/strict";
import {
  EXPLORER_EYE_HEIGHT,
  EXPLORER_PLAYER_WIDTH,
  createExplorerCollisionWorld,
  moveExplorerPlayerAxis,
  setExplorerMoveDirection,
} from "@/lib/voxel/explorerCollision";
import { encodeBinaryVoxelBuild } from "@/lib/voxel/binaryBuild";
import {
  packVoxelBlocks,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import type { VoxelWorldDelivery, VoxelWorldManifest } from "@/lib/voxel/world";

const build: RenderableVoxelBuild = {
  version: "1.0",
  blocks: [
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "water" },
    { x: 2, y: 0, z: 0, type: "lava" },
  ],
};

const largeAxis = 8192;
const largeBuild: RenderableVoxelBuild = {
  version: "1.0",
  blocks: [
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 8191, y: 0, z: 8191, type: "stone" },
    { x: 7, y: 0, z: 32, type: "stone" },
    { x: 8, y: 0, z: 32, type: "water" },
    { x: 16, y: 0, z: 32, type: "lava" },
  ],
};

function largeCellCenter(coordinate: number): number {
  return coordinate - largeAxis / 2 + 0.5;
}

const worldSha = "a".repeat(64);

function source() {
  return {
    format: "voxel-build-json" as const,
    sha256: worldSha,
    evaluatorVersion: 1,
  };
}

function worldBuild(world: VoxelWorldDelivery): RenderableVoxelBuild {
  return { version: "1.0", blocks: [], world };
}

function opaquePart(key: string) {
  return {
    kind: "opaque" as const,
    key,
    encoding: "identity" as const,
    byteSize: 1,
    sha256: worldSha,
  };
}

function localBlobPart(key: string, byteSize: number) {
  return {
    kind: "localBlob" as const,
    key,
    encoding: "identity" as const,
    byteSize,
  };
}

function worldCellCenter(raw: number, boundsOrigin: number, boundsSize: number): number {
  return raw - (boundsOrigin + boundsSize / 2) + 0.5;
}

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

  const largeWorld = await createExplorerCollisionWorld(largeBuild);
  assert.equal(largeWorld.height, 1);
  assert.equal(
    largeWorld.collides({
      x: largeCellCenter(0),
      y: EXPLORER_EYE_HEIGHT,
      z: largeCellCenter(0),
    }),
    true,
  );
  assert.equal(
    largeWorld.collides({
      x: largeCellCenter(8191),
      y: EXPLORER_EYE_HEIGHT,
      z: largeCellCenter(8191),
    }),
    true,
  );
  assert.equal(
    largeWorld.collides({
      x: largeCellCenter(8),
      y: EXPLORER_EYE_HEIGHT,
      z: largeCellCenter(32),
    }),
    false,
  );
  assert.equal(
    largeWorld.isInWater({
      x: largeCellCenter(8),
      y: EXPLORER_EYE_HEIGHT,
      z: largeCellCenter(32),
    }),
    true,
  );
  assert.equal(
    largeWorld.collides({
      x: largeCellCenter(16),
      y: EXPLORER_EYE_HEIGHT,
      z: largeCellCenter(32),
    }),
    false,
  );

  const boundaryWalk = {
    x: largeCellCenter(6),
    y: EXPLORER_EYE_HEIGHT,
    z: largeCellCenter(32),
  };
  assert.equal(moveExplorerPlayerAxis(largeWorld, boundaryWalk, "x", 0.4), true);
  assert.ok(boundaryWalk.x > largeCellCenter(6));
  assert.ok(boundaryWalk.x <= 7 - largeAxis / 2 - EXPLORER_PLAYER_WIDTH / 2 + 0.002);

  const packedLargeWorld = await createExplorerCollisionWorld({
    version: "1.0",
    blocks: [],
    packed: packVoxelBlocks(largeBuild.blocks),
  });
  assert.equal(
    packedLargeWorld.isInWater({
      x: largeCellCenter(8),
      y: EXPLORER_EYE_HEIGHT,
      z: largeCellCenter(32),
    }),
    true,
  );


  const denseManifest: VoxelWorldManifest = {
    kind: "voxel_world",
    version: 1,
    gridSize: 8192,
    palette: "simple",
    bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 8192, y: 8192, z: 8192 } },
    exactBlockCount: 8192 * 8192 + 1,
    leafSize: 64,
    source: source(),
    regions: [
      {
        kind: "uniform",
        key: "ground",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: 8192, y: 1, z: 8192 },
        type: "grass_block",
        blockCount: 8192 * 8192,
      },
      {
        kind: "uniform",
        key: "distant-skyblock",
        origin: { x: 0, y: 8191, z: 0 },
        size: { x: 1, y: 1, z: 1 },
        type: "stone",
        blockCount: 1,
      },
    ],
  };
  const denseWorld = await createExplorerCollisionWorld(worldBuild({ manifest: denseManifest }));
  assert.equal(denseWorld.height, 8192);
  assert.ok(denseWorld.spawnPosition.y < 4);
  assert.equal(denseWorld.collides({ x: 0, y: EXPLORER_EYE_HEIGHT, z: 0 }), true);
  assert.equal(denseWorld.collides({ x: 0, y: EXPLORER_EYE_HEIGHT + 2, z: 0 }), false);

  const denseFall = { ...denseWorld.spawnPosition, y: EXPLORER_EYE_HEIGHT + 8 };
  assert.equal(moveExplorerPlayerAxis(denseWorld, denseFall, "y", -20), true);
  assert.ok(Math.abs(denseFall.y - (1 + EXPLORER_EYE_HEIGHT)) < 0.004);

  const mixedBytes = encodeBinaryVoxelBuild([
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "water" },
  ]);
  const mixedManifest: VoxelWorldManifest = {
    kind: "voxel_world",
    version: 1,
    gridSize: 8192,
    palette: "simple",
    bounds: { origin: { x: 4096, y: 0, z: 4096 }, size: { x: 4, y: 4, z: 4 } },
    exactBlockCount: 2,
    leafSize: 64,
    source: source(),
    regions: [
      {
        kind: "mixed",
        key: "mixed-center",
        origin: { x: 4096, y: 0, z: 4096 },
        size: { x: 4, y: 4, z: 4 },
        blockCount: 2,
        format: "mbv4",
        coordinateSpace: "local",
        data: localBlobPart("mixed-center-data", mixedBytes.byteLength),
      },
    ],
  };
  const mixedWorld = await createExplorerCollisionWorld(worldBuild({
    manifest: mixedManifest,
    resolvePart: async (key) => {
      assert.equal(key, "mixed-center-data");
      return mixedBytes;
    },
  }));
  assert.equal(
    mixedWorld.collides({
      x: worldCellCenter(4096, 4096, 4),
      y: EXPLORER_EYE_HEIGHT,
      z: worldCellCenter(4096, 4096, 4),
    }),
    true,
  );
  assert.equal(
    mixedWorld.collides({
      x: worldCellCenter(4097, 4096, 4),
      y: EXPLORER_EYE_HEIGHT,
      z: worldCellCenter(4096, 4096, 4),
    }),
    false,
  );
  assert.equal(
    mixedWorld.isInWater({
      x: worldCellCenter(4097, 4096, 4),
      y: EXPLORER_EYE_HEIGHT,
      z: worldCellCenter(4096, 4096, 4),
    }),
    true,
  );

  const unloadedMixedManifest: VoxelWorldManifest = {
    ...mixedManifest,
    regions: [
      {
        kind: "mixed",
        key: "unloaded-mixed",
        origin: { x: 4096, y: 0, z: 4096 },
        size: { x: 4, y: 4, z: 4 },
        blockCount: 1,
        format: "mbv4",
        coordinateSpace: "local",
        data: opaquePart("unloaded-mixed-data"),
      },
    ],
    exactBlockCount: 1,
  };
  const unloadedMixedWorld = await createExplorerCollisionWorld(worldBuild({ manifest: unloadedMixedManifest }));
  assert.equal(
    unloadedMixedWorld.collides({
      x: worldCellCenter(4098, 4096, 4),
      y: EXPLORER_EYE_HEIGHT,
      z: worldCellCenter(4098, 4096, 4),
    }),
    true,
  );

  const pageManifest: VoxelWorldManifest = {
    kind: "voxel_world",
    version: 1,
    gridSize: 8192,
    palette: "simple",
    bounds: { origin: { x: 4096, y: 0, z: 4096 }, size: { x: 4, y: 4, z: 4 } },
    exactBlockCount: 1,
    leafSize: 64,
    source: source(),
    regionPages: [
      {
        index: 0,
        bounds: { origin: { x: 4096, y: 0, z: 4096 }, size: { x: 4, y: 4, z: 4 } },
        regionCount: 1,
        blockCount: 1,
        data: opaquePart("page-0"),
      },
    ],
  };
  const unloadedPageWorld = await createExplorerCollisionWorld(worldBuild({ manifest: pageManifest }));
  assert.equal(unloadedPageWorld.collides({ x: 0, y: EXPLORER_EYE_HEIGHT, z: 0 }), true);

  await assert.rejects(
    () =>
      createExplorerCollisionWorld({
        version: "1.0",
        blocks: [
          { x: 0, y: 0, z: 0, type: "stone" },
          { x: 8192, y: 0, z: 0, type: "stone" },
        ],
      }),
    /supported grid/,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
