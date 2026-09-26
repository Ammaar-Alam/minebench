import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { getPalette } from "../../../lib/blocks/palettes";
import {
  appendPackedVoxelBlocks,
  createPackedVoxelBlocks,
  isPackedVoxelBlocks,
  packVoxelBlocks,
  sortPackedVoxelBlocks,
  toObjectBackedVoxelBuild,
  unpackVoxelBlocks,
  voxelBuildBlockAt,
  type RenderableVoxelBuild,
} from "../../../lib/voxel/packedBlocks";
import type { VoxelBlock, VoxelBuild } from "../../../lib/voxel/types";
import {
  parseOwnedVoxelBuildSpec,
  parseVoxelBuildSpec,
  validateOwnedVoxelBuild,
  validateVoxelBuild,
  validateVoxelBuildSpec,
  type ValidatedVoxelBuild,
} from "../../../lib/voxel/validate";

const MEMORY_CHILD = "MINEBENCH_PACKED_VALIDATE_MEMORY_CHILD";
const options = { gridSize: 8, palette: getPalette("simple"), maxBlocks: 8 ** 3 };
const compareBlocks = (a: VoxelBlock, b: VoxelBlock) =>
  a.x - b.x || a.y - b.y || a.z - b.z || a.type.localeCompare(b.type);

function validated(result: ReturnType<typeof validateVoxelBuild>): ValidatedVoxelBuild {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function validatePackedBox() {
  const startedAt = performance.now();
  const { build } = validated(validateOwnedVoxelBuild(
    {
      version: "1.0",
      blocks: [],
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 255, y2: 255, z2: 255, type: "stone" }],
    },
    { gridSize: 256, palette: options.palette, maxBlocks: 256 ** 3, output: "packed" },
  ));
  assert.deepEqual(build.blocks, []);
  assert.equal(build.packed?.count, 256 ** 3);
  assert.equal(build.packed?.positions.length, 256 ** 3 * 3);
  assert.equal(build.packed?.typeIds.length, 256 ** 3);
  assert.deepEqual(build.packed?.typeNames, ["stone"]);
  for (const index of [0, 255, 256, 65_536, 256 ** 3 - 1]) {
    assert.deepEqual(voxelBuildBlockAt(build, index), {
      x: index >>> 16,
      y: (index >>> 8) & 255,
      z: index & 255,
      type: "stone",
    });
  }
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    node: process.version,
    blockCount: build.packed?.count,
    elapsedMs: Math.round(performance.now() - startedAt),
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    peakRssKiB: process.resourceUsage().maxRSS,
  }));
}

async function main() {
  const fixture: VoxelBuild = {
    version: "1.0",
    boxes: [
      { x1: 4, y1: 1, z1: 2, x2: 3, y2: 1, z2: 2, type: "stone" },
      { x1: 6, y1: 0, z1: 0, x2: 6, y2: 0, z2: 1, type: "unknown_crystal" },
    ],
    lines: [{ from: { x: 4, y: 1, z: 2 }, to: { x: 2, y: 1, z: 2 }, type: "oak-plank" }],
    blocks: [
      { x: 3, y: 1, z: 2, type: "minecraft:gold" },
      { x: 0, y: 5, z: 1, type: "minecraft:oak_wood" },
      { x: -1, y: 0, z: 0, type: "stone" },
      { x: 8, y: 0, z: 0, type: "stone" },
      { x: 0, y: 0, z: 0, type: "unknown_crystal" },
      { x: 0, y: 0, z: 0, type: "unknown_metal" },
    ],
  };
  const original = structuredClone(fixture);
  const objectResult = validated(validateVoxelBuild(fixture, options));
  const packedResult = validated(validateVoxelBuild(fixture, { ...options, output: "packed" }));
  assert.deepEqual(fixture, original);
  assert.deepEqual(packedResult.warnings, objectResult.warnings);
  assert.deepEqual(packedResult.warnings, [
    "Dropped 1 blocks with negative coordinates",
    "Dropped 1 blocks outside the grid bounds",
    "Dropped unknown block type: unknown_crystal (3)",
    "Dropped unknown block type: unknown_metal (1)",
  ]);
  assert.deepEqual(packedResult.build.blocks, []);
  assert.deepEqual(packedResult.build.packed, packVoxelBlocks(objectResult.build.blocks));

  const privateBytes = JSON.stringify(objectResult.build);
  assert.equal(JSON.stringify(toObjectBackedVoxelBuild(packedResult.build)), privateBytes);
  assert.deepEqual(voxelBuildBlockAt(packedResult.build, 0), { x: 3, y: 1, z: 2, type: "gold_block" });
  assert.equal(voxelBuildBlockAt(objectResult.build, 0), objectResult.build.blocks[0]);
  for (const index of [-1, 0.5, Number.NaN, Infinity, 4]) {
    assert.equal(voxelBuildBlockAt(packedResult.build, index), undefined);
  }

  sortPackedVoxelBlocks(packedResult.build.packed!);
  const customBytes = JSON.stringify({
    version: "1.0",
    blocks: objectResult.build.blocks.slice().sort(compareBlocks),
  });
  assert.equal(JSON.stringify(toObjectBackedVoxelBuild(packedResult.build)), customBytes);
  assert.notEqual(privateBytes, customBytes);

  const packedSource: RenderableVoxelBuild = {
    ...structuredClone(fixture),
    packed: packVoxelBlocks([
      { x: 3, y: 1, z: 2, type: "minecraft:grass" },
      { x: -2, y: 0, z: 0, type: "stone" },
      { x: 0, y: 0, z: 9, type: "stone" },
      { x: 0, y: 0, z: 0, type: "unknown_metal" },
      { x: 7, y: 7, z: 7, type: "glass" },
    ]),
  };
  const expandedSource = {
    ...fixture,
    blocks: [...fixture.blocks, ...unpackVoxelBlocks(packedSource.packed!)],
  };
  const expected = validated(validateVoxelBuild(expandedSource, options));
  for (const validate of [validateVoxelBuild, validateVoxelBuildSpec]) {
    const result = validated(validate(packedSource, { ...options, output: "packed" }));
    assert.deepEqual(toObjectBackedVoxelBuild(result.build), expected.build);
    assert.deepEqual(result.warnings, expected.warnings);
    assert.deepEqual(validated(validate(packedSource, options)), expected);
  }
  const owned = structuredClone(packedSource);
  const ownedResult = validated(validateOwnedVoxelBuild(owned, { ...options, output: "packed" }));
  assert.deepEqual(toObjectBackedVoxelBuild(ownedResult.build), expected.build);
  assert.deepEqual(ownedResult.warnings, expected.warnings);
  assert.deepEqual(owned.blocks, []);
  assert.deepEqual(owned.boxes, []);
  assert.deepEqual(owned.lines, []);
  assert.equal(owned.packed, undefined);
  assert.equal(packedSource.packed?.count, 5);
  assert.equal(parseOwnedVoxelBuildSpec(packedSource).ok, true);
  const publicSpec = parseVoxelBuildSpec(packedSource);
  assert.equal(publicSpec.ok && "packed" in publicSpec.value, true);
  assert.deepEqual(publicSpec.ok && publicSpec.value, packedSource);

  const validPacked = packVoxelBlocks([{ x: 1, y: 2, z: 3, type: "stone" }]);
  for (const packed of [
    null,
    { ...validPacked, positions: [1, 2, 3] },
    { ...validPacked, typeIds: new Int16Array([0]) },
    { ...validPacked, count: -1 },
    { ...validPacked, count: 0.5 },
    { ...validPacked, count: 2 },
    { ...validPacked, positions: new Int16Array(2) },
    { ...validPacked, typeNames: [] },
    { ...validPacked, typeNames: [""] },
    { ...validPacked, typeNames: new Array(1) },
    { ...validPacked, typeIds: new Uint16Array([1]) },
  ]) {
    assert.equal(isPackedVoxelBlocks(packed), false);
    const input = { version: "1.0" as const, blocks: [], packed } as RenderableVoxelBuild;
    assert.deepEqual(parseOwnedVoxelBuildSpec(input), { ok: false, error: "Invalid packed blocks" });
    for (const validate of [validateVoxelBuild, validateVoxelBuildSpec, validateOwnedVoxelBuild]) {
      assert.deepEqual(validate(input, { ...options, output: "packed" }), {
        ok: false,
        error: "Invalid packed blocks",
      });
    }
  }

  assert.equal(isPackedVoxelBlocks(createPackedVoxelBlocks(0)), true);
  for (const source of [
    [],
    [{ x: 1, y: 2, z: 3, type: "stone" }],
    ...[3, 11, 97].map((count) => Array.from({ length: count }, (_, index) => ({
      x: (index * 17) % 7 - 3,
      y: (index * 11) % 5,
      z: index % 3,
      type: ["stone", "glass", "dirt"][index % 3]!,
    }))),
    [
      { x: 1, y: 1, z: 1, type: "stone" },
      { x: 1, y: 1, z: 1, type: "glass" },
      { x: 1, y: 1, z: 1, type: "dirt" },
    ],
  ]) {
    const packed = createPackedVoxelBlocks(source.length + 1);
    appendPackedVoxelBlocks(packed, source);
    packed.positions.fill(-30000, source.length * 3);
    packed.typeIds[source.length] = 65_535;
    const positions = packed.positions;
    const typeIds = packed.typeIds;
    assert.equal(isPackedVoxelBlocks(packed), true);
    sortPackedVoxelBlocks(packed);
    assert.deepEqual(unpackVoxelBlocks(packed), source.slice().sort(compareBlocks));
    assert.equal(packed.positions, positions);
    assert.equal(packed.typeIds, typeIds);
    assert.equal(packed.positions[source.length * 3], -30000);
    assert.equal(packed.typeIds[source.length], 65_535);
    sortPackedVoxelBlocks(packed);
    assert.deepEqual(unpackVoxelBlocks(packed), source.slice().sort(compareBlocks));
  }

  const overflowOptions = { ...options, maxBlocks: 1, output: "packed" as const };
  assert.deepEqual(
    validateVoxelBuild({ version: "1.0", blocks: [], packed: packVoxelBlocks([
      { x: 0, y: 0, z: 0, type: "stone" },
      { x: 1, y: 0, z: 0, type: "stone" },
    ]) }, overflowOptions),
    { ok: false, error: "Too many blocks (2) > maxBlocks (1)" },
  );
  const require = createRequire(import.meta.url);
  const memoryResult = spawnSync(
    process.execPath,
    ["--max-old-space-size=96", require.resolve("tsx/cli"), fileURLToPath(import.meta.url)],
    { env: { ...process.env, [MEMORY_CHILD]: "1" }, encoding: "utf8" },
  );
  assert.equal(
    memoryResult.status,
    0,
    `packed validation exceeded its heap envelope\n${memoryResult.stderr}`,
  );
  console.log(memoryResult.stdout.trim());
  console.log("packed voxel validation checks passed");
}

const run = process.env[MEMORY_CHILD] === "1" ? Promise.resolve(validatePackedBox()) : main();
run.catch((error) => {
  console.error(error);
  process.exit(1);
});
