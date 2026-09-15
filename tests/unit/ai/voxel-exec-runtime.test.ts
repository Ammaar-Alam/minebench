import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as vm from "node:vm";

import {
  DEFAULT_VOXEL_EXEC_TIMEOUT_MS,
  LARGE_WORLD_VOXEL_EXEC_TIMEOUT_MS,
  runVoxelExec,
} from "../../../lib/ai/tools/voxelExec";
import { unpackVoxelBlocks, unpackVoxelBoxes } from "../../../lib/voxel/packedBlocks";

const originalOutputDir = process.env.MINEBENCH_TOOL_OUTPUT_DIR;
const originalTmpDir = process.env.TMPDIR;
const originalTimeoutMs = process.env.MINEBENCH_TOOL_TIMEOUT_MS;
const testRoot = mkdtempSync(join(tmpdir(), "minebench-voxel-exec-test-"));
const artifactDir = join(testRoot, "artifacts");

// Record the timeout handed to vm.Script#runInContext. Asserting only
// blockCount would pass under an incomplete fix: the pre-fix "" -> Number("")
// === 0 path clamps to 250 and still produces a block.
const originalRunInContext = vm.Script.prototype.runInContext;
function captureTimeout(run: () => void): number | undefined {
  let lastTimeout: number | undefined;
  vm.Script.prototype.runInContext = function (
    this: vm.Script,
    ctx: vm.Context,
    options?: { timeout?: number },
  ) {
    lastTimeout = options?.timeout;
    return originalRunInContext.call(this, ctx, options);
  };
  try {
    run();
  } finally {
    vm.Script.prototype.runInContext = originalRunInContext;
  }
  return lastTimeout;
}

try {
  delete process.env.MINEBENCH_TOOL_OUTPUT_DIR;

  assert.equal(DEFAULT_VOXEL_EXEC_TIMEOUT_MS, 30_000);
  const originalRun = vm.Script.prototype.runInContext;
  const originalTimeout = process.env.MINEBENCH_TOOL_TIMEOUT_MS;
  const timeouts: Array<number | undefined> = [];
  vm.Script.prototype.runInContext = function (context, options) {
    timeouts.push(typeof options === "object" ? options.timeout : undefined);
    return originalRun.call(this, context, options);
  };
  try {
    delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
    for (const gridSize of [512, 8192] as const) {
      const result = runVoxelExec({
        code: 'const Math = { floor: () => 7 }; block(Math.floor(), 0, 0, "stone");',
        gridSize, palette: "simple",
      });
      assert.equal((result.build.packed ? unpackVoxelBlocks(result.build.packed) : result.build.blocks)[0]?.x, 7);
    }
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = "120000";
    runVoxelExec({ code: "", gridSize: 8192, palette: "simple" });
    assert.deepEqual(timeouts, [30_000, LARGE_WORLD_VOXEL_EXEC_TIMEOUT_MS, 120_000]);
  } finally {
    vm.Script.prototype.runInContext = originalRun;
    if (originalTimeout === undefined) delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
    else process.env.MINEBENCH_TOOL_TIMEOUT_MS = originalTimeout;
  }

  for (const [name, code, countKey] of [
    ["MINEBENCH_TOOL_MAX_BLOCKS", 'block(0,0,0,"stone");', "blockCount"],
    ["MINEBENCH_TOOL_MAX_BOXES", 'box(0,0,0,1,1,1,"stone");', "boxCount"],
    ["MINEBENCH_TOOL_MAX_LINES", 'line(0,0,0,1,1,1,"stone");', "lineCount"],
  ] as const) {
    const originalLimit = process.env[name];
    try {
      process.env[name] = "1";
      assert.throws(() => runVoxelExec({ code: code.repeat(2), gridSize: 512, palette: "simple" }), /Too many/);
      for (const gridSize of [2048, 8192] as const) {
        const result = runVoxelExec({ code: code.repeat(2), gridSize, palette: "simple" });
        assert.equal(result[countKey], 2);
      }
    } finally {
      if (originalLimit === undefined) delete process.env[name];
      else process.env[name] = originalLimit;
    }
  }

  const baseArgs = {
    code: 'block(1, 2, 3, "stone");',
    gridSize: 64,
    palette: "simple",
    seed: 123,
  } as const;

  // Unset env -> documented default.
  const unsetTimeout = captureTimeout(() => {
    delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
    runVoxelExec(baseArgs);
  });
  assert.equal(unsetTimeout, DEFAULT_VOXEL_EXEC_TIMEOUT_MS);

  // Non-numeric env falls back to default instead of throwing
  // RangeError "... Received NaN" before the sandbox runs.
  const badTimeout = captureTimeout(() => {
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = "30s";
    runVoxelExec(baseArgs);
  });
  assert.equal(badTimeout, DEFAULT_VOXEL_EXEC_TIMEOUT_MS);

  // Empty string falls back to default. Number("") === 0 is finite, so an
  // isFinite-only guard would clamp to 250 instead of using the default.
  const emptyTimeout = captureTimeout(() => {
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = "";
    runVoxelExec(baseArgs);
  });
  assert.equal(emptyTimeout, DEFAULT_VOXEL_EXEC_TIMEOUT_MS);

  // Non-positive finite values fall back to default (guards the `> 0` check).
  const negativeTimeout = captureTimeout(() => {
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = "-1";
    runVoxelExec(baseArgs);
  });
  assert.equal(negativeTimeout, DEFAULT_VOXEL_EXEC_TIMEOUT_MS);

  // In-range integer passes through the clamp verbatim.
  const normalTimeout = captureTimeout(() => {
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = "5000";
    runVoxelExec(baseArgs);
  });
  assert.equal(normalTimeout, 5000);

  // Below the 250 floor is clamped up.
  const tinyTimeout = captureTimeout(() => {
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = "1";
    runVoxelExec(baseArgs);
  });
  assert.equal(tinyTimeout, 250);

  // Above the 60_000 cap is clamped down.
  const hugeTimeout = captureTimeout(() => {
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = "999999999";
    runVoxelExec(baseArgs);
  });
  assert.equal(hugeTimeout, 60_000);

  // Leave the env clean for the outputDir checks below.
  delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;

  const inMemoryRun = runVoxelExec({
    code: 'block(1, 2, 3, "stone");',
    gridSize: 64,
    palette: "simple",
    seed: 123,
  });
  assert.equal(inMemoryRun.filePath, null);
  assert.equal(inMemoryRun.blockCount, 1);

  const compact = runVoxelExec({
    code: 'box(0,0,0,0,1,1,"stone"); block(0,0,0,"gold_block"); box(1,0,0,2,1,1,"stone"); line(0,0,0,2,0,0,"glass"); block(0,0,0,"water");',
    gridSize: 8192, palette: "simple",
  });
  assert.deepEqual([compact.boxCount, compact.lineCount, compact.blockCount], [2, 1, 2]);
  assert.deepEqual(unpackVoxelBoxes(compact.build.packedBoxes!), [
    { x1: 0, y1: 0, z1: 0, x2: 2, y2: 1, z2: 1, type: "stone" },
  ]);
  assert.deepEqual(compact.build.boxes, []);
  assert.deepEqual(compact.build.blocks, []);
  assert.deepEqual(unpackVoxelBlocks(compact.build.packed!), [
    { x: 0, y: 0, z: 0, type: "gold_block" },
    { x: 0, y: 0, z: 0, type: "water" },
  ]);

  const persistedRun = runVoxelExec({
    code: 'block(4, 5, 6, "oak_log");',
    gridSize: 64,
    palette: "simple",
    seed: 456,
    outputDir: artifactDir,
  });
  assert.ok(persistedRun.filePath);
  const persistedBuild = JSON.parse(readFileSync(persistedRun.filePath, "utf8")) as {
    blocks?: unknown[];
  };
  assert.equal(persistedBuild.blocks?.length, 1);

  const unavailableOutputDir = join(testRoot, "not-a-directory");
  writeFileSync(unavailableOutputDir, "occupied");
  process.env.TMPDIR = testRoot;
  const fallbackRun = runVoxelExec({
    code: 'block(7, 8, 9, "stone");',
    gridSize: 64,
    palette: "simple",
    outputDir: unavailableOutputDir,
  });
  assert.ok(fallbackRun.filePath);
  const fallbackDir = join(testRoot, "minebench-tool-runs");
  assert.equal(dirname(fallbackRun.filePath), fallbackDir);
  assert.equal(existsSync(fallbackDir), true);
  assert.equal(
    (JSON.parse(readFileSync(fallbackRun.filePath, "utf8")) as { blocks?: unknown[] }).blocks
      ?.length,
    1,
  );

  console.log("voxel exec runtime checks passed");
} finally {
  if (originalTimeoutMs === undefined) {
    delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
  } else {
    process.env.MINEBENCH_TOOL_TIMEOUT_MS = originalTimeoutMs;
  }
  if (originalOutputDir === undefined) {
    delete process.env.MINEBENCH_TOOL_OUTPUT_DIR;
  } else {
    process.env.MINEBENCH_TOOL_OUTPUT_DIR = originalOutputDir;
  }
  if (originalTmpDir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = originalTmpDir;
  }
  rmSync(testRoot, { recursive: true, force: true });
}
