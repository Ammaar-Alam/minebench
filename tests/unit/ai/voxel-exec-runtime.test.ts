import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

import { getPalette } from "../../../lib/blocks/palettes";
import { canonicalBuildJsonChunks } from "../../../lib/voxel/canonicalArtifact";
import { validateOwnedVoxelBuild } from "../../../lib/voxel/validate";

const originalOutputDir = process.env.MINEBENCH_TOOL_OUTPUT_DIR;
const originalTmpDir = process.env.TMPDIR;
const originalTimeoutMs = process.env.MINEBENCH_TOOL_TIMEOUT_MS;
const testRoot = mkdtempSync(join(tmpdir(), "minebench-voxel-exec-test-"));
const artifactDir = join(testRoot, "artifacts");

// capture the actual VM deadline since successful execution alone would miss a wrong timeout
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
  for (const gridSize of [512, 8192] as const) {
    delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
    assert.equal(captureTimeout(() => {
      const result = runVoxelExec({
        code: 'const Math = { floor: () => 7 }; block(Math.floor(), 0, 0, "stone");',
        gridSize, palette: "simple",
      });
      assert.equal((result.build.packed ? unpackVoxelBlocks(result.build.packed) : result.build.blocks)[0]?.x, 7);
    }), gridSize > 512 ? LARGE_WORLD_VOXEL_EXEC_TIMEOUT_MS : DEFAULT_VOXEL_EXEC_TIMEOUT_MS);
  }
  process.env.MINEBENCH_TOOL_TIMEOUT_MS = "120000";
  assert.equal(captureTimeout(() => runVoxelExec({ code: "", gridSize: 8192, palette: "simple" })), 120_000);

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

  for (const gridSize of [32, 64, 256, 512] as const) {
    const hashes = [false, true].map((packedOutput) => {
      const executed = runVoxelExec({
        code: 'box(0,0,0,1,0,0,"stone"); box(0,1,0,1,1,0,"stone");',
        gridSize, palette: "simple", packedOutput,
      });
      const validated = validateOwnedVoxelBuild(executed.build, {
        gridSize, palette: getPalette("simple"), maxBlocks: gridSize ** 3,
        output: packedOutput ? "packed" : "objects",
      });
      assert.ok(validated.ok);
      const hash = createHash("sha256");
      for (const chunk of canonicalBuildJsonChunks(validated.value.build)) hash.update(chunk);
      return hash.digest("hex");
    });
    assert.equal(hashes[1], hashes[0], `packed execution must preserve canonical insertion order for grid ${gridSize}`);
  }

  const baseArgs = {
    code: 'block(1, 2, 3, "stone");',
    gridSize: 64,
    palette: "simple",
    seed: 123,
  } as const;

  for (const [configured, expected] of [
    [undefined, DEFAULT_VOXEL_EXEC_TIMEOUT_MS], ["30s", DEFAULT_VOXEL_EXEC_TIMEOUT_MS],
    ["", DEFAULT_VOXEL_EXEC_TIMEOUT_MS], ["-1", DEFAULT_VOXEL_EXEC_TIMEOUT_MS],
    ["5000", 5000], ["1", 250], ["999999999", 60_000],
  ] as const) {
    if (configured === undefined) delete process.env.MINEBENCH_TOOL_TIMEOUT_MS;
    else process.env.MINEBENCH_TOOL_TIMEOUT_MS = configured;
    assert.equal(captureTimeout(() => runVoxelExec(baseArgs)), expected, `timeout setting: ${configured}`);
  }

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
