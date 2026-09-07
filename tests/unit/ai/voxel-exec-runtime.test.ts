import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  DEFAULT_VOXEL_EXEC_TIMEOUT_MS,
  LARGE_WORLD_VOXEL_EXEC_TIMEOUT_MS,
  runVoxelExec,
} from "../../../lib/ai/tools/voxelExec";
import { unpackVoxelBlocks } from "../../../lib/voxel/packedBlocks";

const originalOutputDir = process.env.MINEBENCH_TOOL_OUTPUT_DIR;
const originalTmpDir = process.env.TMPDIR;
const testRoot = mkdtempSync(join(tmpdir(), "minebench-voxel-exec-test-"));
const artifactDir = join(testRoot, "artifacts");

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
  assert.equal(compact.build.boxes?.length, 1);
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
