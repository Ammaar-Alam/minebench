import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as vm from "node:vm";

import {
  DEFAULT_VOXEL_EXEC_TIMEOUT_MS,
  runVoxelExec,
} from "../../../lib/ai/tools/voxelExec";

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
