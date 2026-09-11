import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  EXPLORER_EYE_HEIGHT,
  EXPLORER_PLAYER_WIDTH,
  adjustExplorerNoclipSpeedMultiplier,
  createExplorerCollisionWorld,
  moveExplorerPlayerAxis,
  readVoxelWorldPartBytes,
  setExplorerMoveDirection,
} from "@/lib/voxel/explorerCollision";
import { encodeBinaryVoxelBuild } from "@/lib/voxel/binaryBuild";
import {
  packVoxelBlocks,
  type RenderableVoxelBuild,
} from "@/lib/voxel/packedBlocks";
import type { VoxelWorldDelivery, VoxelWorldManifest, VoxelWorldRegionPage } from "@/lib/voxel/world";

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
  assert.equal(adjustExplorerNoclipSpeedMultiplier(1, -100), 2);
  assert.equal(adjustExplorerNoclipSpeedMultiplier(5, -100), 6);
  assert.equal(adjustExplorerNoclipSpeedMultiplier(9, -100), 10);
  assert.equal(adjustExplorerNoclipSpeedMultiplier(10, -100), 10);
  assert.equal(adjustExplorerNoclipSpeedMultiplier(2, 100), 1);
  assert.equal(adjustExplorerNoclipSpeedMultiplier(1, 100), 1);
  assert.equal(adjustExplorerNoclipSpeedMultiplier(3, 0), 3);

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
  const compressedPart = { ...localBlobPart("compressed", mixedBytes.byteLength), encoding: "gzip" as const };
  for (const bytes of [gzipSync(mixedBytes), mixedBytes]) {
    assert.deepEqual(await readVoxelWorldPartBytes({
      manifest: denseManifest,
      resolvePart: async () => bytes,
    }, compressedPart), mixedBytes, "HTTP-decoded parts are not decompressed twice");
  }
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
    bounds: { origin: { x: 4096, y: 0, z: 4096 }, size: { x: 256, y: 4, z: 4 } },
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
      x: worldCellCenter(4098, 4096, 256),
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
    bounds: { origin: { x: 4096, y: 0, z: 4096 }, size: { x: 256, y: 4, z: 4 } },
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
  assert.equal(unloadedPageWorld.collides({ x: -126, y: EXPLORER_EYE_HEIGHT, z: 0 }), true);

  await assert.rejects(createExplorerCollisionWorld(worldBuild({
    manifest: mixedManifest,
    resolvePart: async () => { throw new Error("collision part unavailable"); },
  })), /collision part unavailable/);

  const streamingManifest: VoxelWorldManifest = {
    ...mixedManifest,
    bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1024, y: 64, z: 64 } },
    exactBlockCount: 6,
    regions: [0, 512, 960].map((x) => ({
      kind: "mixed", key: `region-${x}`, origin: { x, y: 0, z: 0 },
      size: { x: 64, y: 64, z: 64 }, blockCount: 2, format: "mbv4", coordinateSpace: "local",
      data: localBlobPart(`part-${x}`, mixedBytes.byteLength),
    })),
  };
  const partReads = new Map<string, number>();
  const streamingWorld = await createExplorerCollisionWorld(worldBuild({
    manifest: streamingManifest,
    resolvePart: async (key) => {
      partReads.set(key, (partReads.get(key) ?? 0) + 1);
      return mixedBytes;
    },
  }));
  for (const x of [-500, 500, -500]) {
    await streamingWorld.updateActiveCamera?.({ x, y: 2, z: 0 });
  }
  assert.equal(partReads.get("part-0"), 2, "distant collision buffers are evicted and reloaded on return");

  let activeReads = 0;
  let peakReads = 0;
  await createExplorerCollisionWorld(worldBuild({
    manifest: {
      ...streamingManifest,
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 64, y: 512, z: 64 } },
      exactBlockCount: 16,
      regions: Array.from({ length: 8 }, (_, index) => ({
        kind: "mixed", key: `level-${index}`, origin: { x: 0, y: index * 64, z: 0 },
        size: { x: 64, y: 64, z: 64 }, blockCount: 2, format: "mbv4", coordinateSpace: "local",
        data: localBlobPart(`level-${index}`, mixedBytes.byteLength),
      })),
    },
    resolvePart: async () => {
      peakReads = Math.max(peakReads, ++activeReads);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeReads -= 1;
      return mixedBytes;
    },
  }));
  assert.ok(peakReads <= 2, `collision reads must stay bounded, saw ${peakReads}`);

  for (const type of [null, "stone", "water", "lava"] as const) {
    const bytes = encodeBinaryVoxelBuild([type
      ? { x: 0, y: 12, z: 0, type }
      : { x: 63, y: 63, z: 63, type: "stone" }]);
    const pages: VoxelWorldRegionPage[] = Array.from({ length: 9 }, (_, index) => ({
      kind: "voxel_world_region_page", version: 1, index, bounds: denseManifest.bounds!, regionCount: 1, blockCount: 1,
      regions: [index < 8 ? {
        kind: "uniform", key: `far-${index}`, origin: { x: index, y: 8191, z: 0 },
        size: { x: 1, y: 1, z: 1 }, type: "stone", blockCount: 1,
      } : {
        kind: "mixed", key: "column", origin: { x: 4096, y: 0, z: 4096 },
        size: { x: 64, y: 64, z: 64 }, blockCount: 1, format: "mbv4", coordinateSpace: "local",
        data: localBlobPart("column", bytes.byteLength),
      }],
    }));
    const parts = new Map<string, Uint8Array>(pages.map((page) => [`page-${page.index}`, new TextEncoder().encode(JSON.stringify(page))]));
    parts.set("column", bytes);
    const reads: string[] = [];
    let pending = 0;
    let peak = 0;
    const delivery: VoxelWorldDelivery = {
      manifest: {
        ...denseManifest, regions: undefined, exactBlockCount: 9,
        regionPages: pages.map(({ index, bounds, regionCount, blockCount }) => ({
          index, bounds, regionCount, blockCount, data: localBlobPart(`page-${index}`, parts.get(`page-${index}`)!.byteLength),
        })),
      },
      resolvePart: async (key) => {
        reads.push(key);
        peak = Math.max(peak, ++pending);
        await Promise.resolve();
        pending--;
        return parts.get(key)!;
      },
    };
    const paged = await createExplorerCollisionWorld(worldBuild(delivery));
    assert.equal(paged.spawnPosition.y, (type === "stone" || type === "water" ? 13 : 2) + EXPLORER_EYE_HEIGHT + 0.2);
    assert.deepEqual(reads.slice(-2), ["page-8", "column"], "spawn checks actual occupancy beyond the eight resident pages");
    assert.equal(peak, 1, "additional spawn pages and leaves are inspected sequentially");
    const count = reads.length;
    await paged.updateActiveCamera?.(paged.spawnPosition);
    assert.equal(reads.length, count, "spawn probing does not replace the bounded nearby page cache");

    if (type === null) {
      await assert.rejects(createExplorerCollisionWorld(worldBuild({
        ...delivery, resolvePart: async (key) => {
          if (key === "page-8") throw new Error("spawn page unavailable");
          return parts.get(key)!;
        },
      })), /spawn page unavailable/);
      const controller = new AbortController();
      await assert.rejects(createExplorerCollisionWorld(worldBuild({
        ...delivery, resolvePart: async (key) => {
          if (key === "page-8") controller.abort();
          return parts.get(key)!;
        },
      }), { signal: controller.signal }), { name: "AbortError" });
    }

    if (type === "stone") {
      const upperPage: VoxelWorldRegionPage = {
        ...pages[8], index: 9,
        bounds: { ...denseManifest.bounds!, size: { x: 8192, y: 128, z: 8192 } },
        regions: [{ kind: "uniform", key: "upper-floor", origin: { x: 4096, y: 100, z: 4096 }, size: { x: 1, y: 1, z: 1 }, type: "stone", blockCount: 1 }],
      };
      const orderedPages = [...pages.slice(0, 8), { ...pages[8], bounds: { ...denseManifest.bounds!, size: { x: 8192, y: 64, z: 8192 } } }, upperPage];
      const orderedParts = new Map(orderedPages.map((page) => [`page-${page.index}`, new TextEncoder().encode(JSON.stringify(page))]));
      const requested: string[] = [];
      const upperWorld = await createExplorerCollisionWorld(worldBuild({
        manifest: {
          ...delivery.manifest, exactBlockCount: 10,
          regionPages: orderedPages.map(({ index, bounds, regionCount, blockCount }) => ({
            index, bounds, regionCount, blockCount, data: localBlobPart(`page-${index}`, orderedParts.get(`page-${index}`)!.byteLength),
          })),
        },
        resolvePart: async (key) => {
          requested.push(key);
          assert.notEqual(key, "page-8", "pages below a known floor are pruned");
          return orderedParts.get(key)!;
        },
      }));
      assert.equal(upperWorld.spawnPosition.y, 101 + EXPLORER_EYE_HEIGHT + 0.2);
      assert.equal(requested.at(-1), "page-9", "higher candidate pages are inspected first");
    }
  }

  const emptyColumnBytes = encodeBinaryVoxelBuild([{ x: 63, y: 63, z: 63, type: "stone" }]);
  const floorColumnBytes = encodeBinaryVoxelBuild([{ x: 0, y: 7, z: 0, type: "stone" }]);
  const columnReads = new Map<string, number>();
  const manyLeaves = await createExplorerCollisionWorld(worldBuild({
    manifest: {
      ...denseManifest, exactBlockCount: 129,
      regions: Array.from({ length: 129 }, (_, index) => ({
        kind: "mixed", key: `column-${index}`, origin: { x: 4096, y: 0, z: 4096 },
        size: { x: 64, y: 64, z: 64 }, blockCount: 1, format: "mbv4", coordinateSpace: "local",
        data: localBlobPart(`column-${index}`, emptyColumnBytes.byteLength),
      })),
    },
    resolvePart: async (key) => {
      columnReads.set(key, (columnReads.get(key) ?? 0) + 1);
      return key === "column-128" ? floorColumnBytes : emptyColumnBytes;
    },
  }));
  assert.equal(manyLeaves.spawnPosition.y, 8 + EXPLORER_EYE_HEIGHT + 0.2);
  await manyLeaves.updateActiveCamera?.({ x: -3000, y: 100, z: 0 });
  await manyLeaves.updateActiveCamera?.(manyLeaves.spawnPosition);
  assert.equal(columnReads.get("column-0"), 2, "the nearby leaf cache still evicts on movement");
  assert.equal(columnReads.get("column-128"), 1, "the spawn-only leaf is not retained beyond the 128-leaf cache");

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
