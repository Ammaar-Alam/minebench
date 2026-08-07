import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_VOXEL_EXEC_TIMEOUT_MS,
  runVoxelExec,
} from "../../../lib/ai/tools/voxelExec";

const originalOutputDir = process.env.MINEBENCH_TOOL_OUTPUT_DIR;
const originalTmpDir = process.env.TMPDIR;
const testRoot = mkdtempSync(join(tmpdir(), "minebench-voxel-exec-test-"));
const artifactDir = join(testRoot, "artifacts");

try {
  delete process.env.MINEBENCH_TOOL_OUTPUT_DIR;

  assert.equal(DEFAULT_VOXEL_EXEC_TIMEOUT_MS, 30_000);

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
