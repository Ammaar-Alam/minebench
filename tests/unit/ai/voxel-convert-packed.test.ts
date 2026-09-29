import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const directory = mkdtempSync(path.join(tmpdir(), "voxel-convert-"));
try {
  const input = path.join(directory, "input.json");
  writeFileSync(input, JSON.stringify({ tool: "voxel.exec", input: {
    code: 'box(0,0,0,3,0,0,"stone"); block(1,0,0,"glass"); block(8191,1,8191,"gold_block");',
    gridSize: 8192, palette: "simple", seed: 1,
  } }));
  for (const expanded of [false, true]) {
    const output = path.join(directory, "output.json");
    execFileSync(process.execPath, ["--import", "tsx", "scripts/convert-voxel-tool-call.ts", "--in", input, "--out", output, ...(expanded ? ["--expanded"] : [])]);
    const build = JSON.parse(readFileSync(output, "utf8"));
    assert.equal("packed" in build, false);
    assert.equal(build.blocks.length, expanded ? 5 : 2);
    assert.equal(build.blocks.find((block: { x: number }) => block.x === 1).type, "glass");
    assert.equal(build.blocks.find((block: { x: number }) => block.x === 8191).type, "gold_block");
  }
  console.log("packed converter round-trip checks passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
