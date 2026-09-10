import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { getPalette } from "../../../lib/blocks/palettes";
import {
  createVoxelWorldRegionEvaluator,
  evaluateVoxelWorldRegions,
  summarizeVoxelWorldRegions,
  type VoxelWorldRegion,
} from "../../../lib/voxel/worldRegions";
import type { VoxelBuild, VoxelBlock } from "../../../lib/voxel/types";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { validateVoxelBuild } from "../../../lib/voxel/validate";

const MEMORY_CHILD = "MINEBENCH_WORLD_REGIONS_MEMORY_CHILD";

function key(block: Pick<VoxelBlock, "x" | "y" | "z">): string {
  return `${block.x},${block.y},${block.z}`;
}

function expandRegions(regions: VoxelWorldRegion[], palette: ReturnType<typeof getPalette>): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const region of regions) {
    if (region.kind === "uniform") {
      for (let z = region.origin.z; z < region.origin.z + region.size.z; z += 1) {
        for (let y = region.origin.y; y < region.origin.y + region.size.y; y += 1) {
          for (let x = region.origin.x; x < region.origin.x + region.size.x; x += 1) {
            blocks.set(`${x},${y},${z}`, region.type);
          }
        }
      }
      continue;
    }

    const sx = region.size.x;
    const strideZ = region.size.x * region.size.y;
    for (let z = 0; z < region.size.z; z += 1) {
      for (let y = 0; y < region.size.y; y += 1) {
        for (let x = 0; x < region.size.x; x += 1) {
          const material = region.materialIndexes[x + y * sx + z * strideZ]!;
          if (material === 0) continue;
          blocks.set(
            `${region.origin.x + x},${region.origin.y + y},${region.origin.z + z}`,
            palette[material - 1]!.id,
          );
        }
      }
    }
  }
  return blocks;
}

function assertMatchesValidator(build: VoxelBuild, gridSize: number) {
  const original = structuredClone(build);
  const palette = getPalette("simple");
  const expected = validateVoxelBuild(build, {
    gridSize,
    palette,
    maxBlocks: gridSize ** 3,
  });
  if (!expected.ok) throw new Error(expected.error);

  for (const source of [build, { ...build, blocks: [], packed: packVoxelBlocks(build.blocks) },
    { ...build, blocks: build.blocks.slice(0, 300), packed: packVoxelBlocks(build.blocks.slice(300)) }]) {
    const evaluated = evaluateVoxelWorldRegions(source, { gridSize, palette });
    if (!evaluated.ok) throw new Error(evaluated.error);
    assert.deepEqual(evaluated.warnings, expected.value.warnings);
    const actualBlocks = expandRegions(Array.from(evaluated.regions), palette);
    assert.equal(actualBlocks.size, expected.value.build.blocks.length);
    for (const block of expected.value.build.blocks) {
      assert.equal(actualBlocks.get(key(block)), block.type, key(block));
    }
  }
  assert.deepEqual(build, original, "region evaluation must preserve the canonical source");
}

function sumBlocks(regions: VoxelWorldRegion[]): number {
  return regions.reduce((sum, region) => sum + region.blockCount, 0);
}

function assertTightenedGroundRegions() {
  const palette = getPalette("simple");
  const build: VoxelBuild = {
    version: "1.0",
    boxes: [
      { x1: 0, y1: 0, z1: 0, x2: 127, y2: 0, z2: 127, type: "grass_block" },
      { x1: 96, y1: 1, z1: 96, x2: 111, y2: 16, z2: 111, type: "stone" },
    ],
    blocks: [],
  };
  assertMatchesValidator(build, 128);

  const evaluator = createVoxelWorldRegionEvaluator(build, { gridSize: 128, palette });
  if (!evaluator.ok) throw new Error(evaluator.error);
  const regions = Array.from(evaluator.value.regions);
  assert.equal(sumBlocks(regions), 20_480);
  assert.ok(regions.some((region) => region.kind === "uniform" && region.size.y === 1));
  assert.ok(regions.every((region) => region.kind === "uniform" || region.size.y <= 64));

  const groundLeaf = evaluator.value.evaluateBounds({ x: 0, y: 0, z: 0 }, { x: 64, y: 1, z: 64 });
  assert.deepEqual(groundLeaf, {
    ok: true,
    region: {
      kind: "uniform",
      origin: { x: 0, y: 0, z: 0 },
      size: { x: 64, y: 1, z: 64 },
      type: "grass_block",
      blockCount: 4096,
    },
  });

  const oversized = evaluator.value.evaluateBounds({ x: 0, y: 0, z: 0 }, { x: 65, y: 1, z: 1 });
  assert.deepEqual(oversized, { ok: false, error: "Bounds size must be at most 64 per axis" });
}

function assertLargeWorldSmoke() {
  const palette = getPalette("simple");
  const fullBuild: VoxelBuild = {
    version: "1.0",
    blocks: [],
    boxes: [{ x1: 0, y1: 0, z1: 0, x2: 8191, y2: 8191, z2: 8191, type: "stone" }],
  };
  const full = evaluateVoxelWorldRegions(
    fullBuild,
    { gridSize: 8192, palette },
  );
  if (!full.ok) throw new Error(full.error);
  const fullRegions = Array.from(full.regions);
  assert.deepEqual(fullRegions, [
    {
      kind: "uniform",
      origin: { x: 0, y: 0, z: 0 },
      size: { x: 8192, y: 8192, z: 8192 },
      type: "stone",
      blockCount: 549_755_813_888,
    },
  ]);

  const fullSummary = summarizeVoxelWorldRegions(fullBuild, { gridSize: 8192, palette });
  if (!fullSummary.ok) throw new Error(fullSummary.error);
  assert.equal(fullSummary.value.blockCount, 549_755_813_888);
  assert.deepEqual(fullSummary.value.bounds, {
    origin: { x: 0, y: 0, z: 0 },
    size: { x: 8192, y: 8192, z: 8192 },
  });

  const boundary = evaluateVoxelWorldRegions(
    {
      version: "1.0",
      blocks: [],
      packed: packVoxelBlocks([{ x: 8191, y: 8191, z: 8191, type: "glass" }]),
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 8191, y2: 8191, z2: 8191, type: "stone" }],
    },
    { gridSize: 8192, palette },
  );
  if (!boundary.ok) throw new Error(boundary.error);
  const boundaryRegions = Array.from(boundary.regions);
  assert.equal(sumBlocks(boundaryRegions), 549_755_813_888);
  assert.ok(boundaryRegions.length < 100);
  assert.ok(
    boundaryRegions.every(
      (region) =>
        region.kind === "uniform" ||
        (region.size.x <= 64 && region.size.y <= 64 && region.size.z <= 64),
    ),
  );
  assert.equal(boundaryRegions.filter((region) => region.kind === "mixed").length, 1);
}

async function main() {
  assertMatchesValidator({
    version: "1.0",
    boxes: [{ x1: 0, y1: 0, z1: 0, x2: 15, y2: 3, z2: 15, type: "stone" }],
    lines: Array.from({ length: 40 }, (_, index) => ({
      from: { x: index * 7 % 25 - 4, y: index * 3 % 21 - 2, z: index * 13 % 25 - 4 },
      to: { x: index * 13 % 25 - 4, y: index * 5 % 21 - 2, z: index * 7 % 25 - 4 },
      type: ["oak-plank", "glass", "gold", "stone", "unknown"][index % 5],
    })),
    blocks: [{ x: 0, y: 0, z: 0, type: "water" }, { x: 0, y: 0, z: 0, type: "oak_log" }],
  }, 16);
  const scattered = Array.from({ length: 600 }, (_, index) => ({
    x: index * 37 % 128, y: index * 17 % 96, z: index * 73 % 128,
    type: index < 300 ? "water" : "glass",
  }));
  const isolated = createVoxelWorldRegionEvaluator({ version: "1.0", blocks: [], packed: packVoxelBlocks(scattered) }, {
    gridSize: 128, palette: getPalette("simple"),
  });
  if (!isolated.ok) throw new Error(isolated.error);
  const first = isolated.value.regions[Symbol.iterator]();
  const partial = [first.next().value as VoxelWorldRegion];
  const independentlyEvaluated = Array.from(isolated.value.regions);
  assert.equal(isolated.value.evaluateBounds({ x: 0, y: 0, z: 0 }, { x: 64, y: 64, z: 64 }).ok, true);
  for (let next = first.next(); !next.done; next = first.next()) partial.push(next.value);
  assert.deepEqual(expandRegions(partial, getPalette("simple")), expandRegions(independentlyEvaluated, getPalette("simple")));
  assertMatchesValidator({
    version: "1.0",
    boxes: [{ x1: 0, y1: 0, z1: 0, x2: 127, y2: 0, z2: 127, type: "stone" }],
    lines: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 127, y: 95, z: 127 }, type: "gold_block" }],
    blocks: [...scattered, ...scattered.slice(0, 50).map((block) => ({ ...block, type: "oak_log" }))],
  }, 128);
  assertMatchesValidator(
    {
      version: "1.0",
      boxes: [
        { x1: 0, y1: 0, z1: 0, x2: 4, y2: 3, z2: 1, type: "stone" },
        { x1: 2, y1: 1, z1: 0, x2: 6, y2: 3, z2: 1, type: "minecraft:grass" },
        { x1: -1, y1: 0, z1: 0, x2: 1, y2: 0, z2: 0, type: "glass" },
      ],
      lines: [
        { from: { x: 0, y: 0, z: 0 }, to: { x: 7, y: 7, z: 0 }, type: "oak-plank" },
        { from: { x: -2, y: 1, z: 0 }, to: { x: 3, y: 1, z: 0 }, type: "gold" },
        { from: { x: 5, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, type: "unknown" },
      ],
      blocks: [
        { x: 2, y: 2, z: 0, type: "gold_block" },
        { x: 8, y: 0, z: 0, type: "stone" },
        { x: 0, y: -1, z: 0, type: "stone" },
        { x: 1, y: 1, z: 1, type: "missing" },
      ],
    },
    8,
  );

  assertMatchesValidator(
    {
      version: "1.0",
      boxes: [
        { x1: 6, y1: 6, z1: 6, x2: 3, y2: 3, z2: 3, type: "stonebrick" },
        { x1: 4, y1: 4, z1: 4, x2: 7, y2: 7, z2: 7, type: "ice_block" },
      ],
      lines: [
        { from: { x: 7, y: 0, z: 0 }, to: { x: 7, y: 7, z: 7 }, type: "minecraft:oak_wood" },
      ],
      blocks: [
        { x: 7, y: 7, z: 7, type: "glowstone_block" },
        { x: 4, y: 4, z: 4, type: "snow_block" },
      ],
    },
    8,
  );

  const empty = evaluateVoxelWorldRegions(
    { version: "1.0", boxes: [{ x1: 0, y1: 0, z1: 0, x2: 2, y2: 2, z2: 2, type: "unknown" }], blocks: [] },
    { gridSize: 8, palette: getPalette("simple") },
  );
  if (!empty.ok) throw new Error(empty.error);
  assert.deepEqual(Array.from(empty.regions), []);
  assert.deepEqual(empty.warnings, ["Dropped unknown block type: unknown (27)"]);

  assertTightenedGroundRegions();

  if (process.env[MEMORY_CHILD] === "1") {
    assertLargeWorldSmoke();
    const lines = summarizeVoxelWorldRegions({ version: "1.0", blocks: [],
      lines: Array.from({ length: 128 }, (_, y) => ({
        from: { x: 0, y, z: 0 }, to: { x: 8191, y, z: 0 }, type: "stone",
      })),
    }, { gridSize: 8192, palette: getPalette("simple") });
    assert.ok(lines.ok);
    assert.equal(lines.value.blockCount, 128 * 8192);
    assert.deepEqual(lines.value.warnings, []);
    return;
  }

  const require = createRequire(import.meta.url);
  const memoryResult = spawnSync(
    process.execPath,
    ["--max-old-space-size=96", require.resolve("tsx/cli"), fileURLToPath(import.meta.url)],
    {
      env: { ...process.env, [MEMORY_CHILD]: "1" },
      encoding: "utf8",
    },
  );
  assert.equal(
    memoryResult.status,
    0,
    `large-world region evaluation exceeded its heap envelope\n${memoryResult.stderr}`,
  );

  const longLine = summarizeVoxelWorldRegions(
    {
      version: "1.0",
      blocks: [],
      lines: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 1_000_000, y: 0, z: 0 }, type: "stone" }],
    },
    { gridSize: 8192, palette: getPalette("simple") },
  );
  if (!longLine.ok) throw new Error(longLine.error);
  assert.equal(longLine.value.blockCount, 8192);
  assert.deepEqual(longLine.value.warnings, ["Dropped 991809 blocks outside the grid bounds"]);

  const manyLines = summarizeVoxelWorldRegions(
    {
      version: "1.0",
      blocks: [],
      lines: Array.from({ length: 128 }, (_, y) => ({
        from: { x: 0, y, z: 0 }, to: { x: 8191, y, z: 0 }, type: "stone",
      })),
    },
    { gridSize: 8192, palette: getPalette("simple") },
  );
  if (!manyLines.ok) throw new Error(manyLines.error);
  assert.equal(manyLines.value.blockCount, 128 * 8192);
  assert.deepEqual(manyLines.value.warnings, []);

  console.log("voxel world region checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
