import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { getPalette } from "../../../lib/blocks/palettes";
import { validateOwnedVoxelBuild, validateVoxelBuild } from "../../../lib/voxel/validate";

const MEMORY_CHILD = "MINEBENCH_VALIDATE_MEMORY_CHILD";

function validateMillionBlockBox() {
  const result = validateVoxelBuild(
    {
      version: "1.0",
      blocks: [],
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 99, y2: 99, z2: 99, type: "stone" }],
    },
    { gridSize: 512, palette: getPalette("simple"), maxBlocks: 512 ** 3 },
  );
  assert.equal(result.ok && result.value.build.blocks.length, 1_000_000);
}

async function main() {
  const result = validateVoxelBuild(
    {
      version: "1.0",
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 1, y2: 0, z2: 0, type: "stone" }],
      lines: [
        { from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 }, type: "oak-plank" },
      ],
      blocks: [
        { x: 0, y: 0, z: 0, type: "gold_block" },
        { x: 3, y: 0, z: 0, type: "unknown" },
        { x: -1, y: 0, z: 0, type: "stone" },
        { x: 8, y: 0, z: 0, type: "stone" },
      ],
    },
    { gridSize: 8, palette: getPalette("simple"), maxBlocks: 8 ** 3 },
  );

  if (!result.ok) throw new Error(result.error);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.build.blocks, [
    { x: 0, y: 0, z: 0, type: "gold_block" },
    { x: 1, y: 0, z: 0, type: "oak_planks" },
    { x: 2, y: 0, z: 0, type: "oak_planks" },
  ]);
  assert.deepEqual(result.value.warnings, [
    "Dropped 1 blocks with negative coordinates",
    "Dropped 1 blocks outside the grid bounds",
    "Dropped unknown block type: unknown (1)",
  ]);

  const distant = validateVoxelBuild(
    {
      version: "1.0",
      blocks: [
        { x: 0, y: 0, z: 0, type: "stone" },
        { x: 0, y: 256, z: 0, type: "dirt" },
        { x: 0, y: 0, z: 256, type: "gold_block" },
        { x: 511, y: 511, z: 511, type: "glass" },
      ],
    },
    { gridSize: 512, palette: getPalette("simple"), maxBlocks: 512 ** 3 },
  );
  if (!distant.ok) throw new Error(distant.error);
  assert.equal(distant.ok, true);
  assert.deepEqual(distant.value.build.blocks, [
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 0, y: 256, z: 0, type: "dirt" },
    { x: 0, y: 0, z: 256, type: "gold_block" },
    { x: 511, y: 511, z: 511, type: "glass" },
  ]);

  const overLimit = validateVoxelBuild(
    {
      version: "1.0",
      blocks: [
        { x: 0, y: 0, z: 0, type: "stone" },
        { x: 1, y: 0, z: 0, type: "stone" },
      ],
    },
    { gridSize: 8, palette: getPalette("simple"), maxBlocks: 1 },
  );
  assert.equal(overLimit.ok, false);
  if (overLimit.ok) throw new Error("Expected the max-block check to fail");
  assert.equal(overLimit.error, "Too many blocks (2) > maxBlocks (1)");

  const uploaded = validateOwnedVoxelBuild(
    { version: "1.0", blocks: [{ x: 1, y: 2, z: 3, type: "stone" }] },
    { gridSize: 8, palette: getPalette("simple"), maxBlocks: 8 ** 3 },
  );
  assert.equal(uploaded.ok && uploaded.value.build.blocks.length, 1);
  assert.deepEqual(
    validateOwnedVoxelBuild(
      { version: "1.0", blocks: [{ x: 1.5, y: 2, z: 3, type: "stone" }] },
      { gridSize: 8, palette: getPalette("simple"), maxBlocks: 8 ** 3 },
    ),
    { ok: false, error: "Invalid block at index 0" },
  );

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
    `million-block validation exceeded its heap envelope\n${memoryResult.stderr}`,
  );

  console.log("voxel validation checks passed");
}

const run = process.env[MEMORY_CHILD] === "1" ? Promise.resolve(validateMillionBlockBox()) : main();
run.catch((error) => {
  console.error(error);
  process.exit(1);
});
