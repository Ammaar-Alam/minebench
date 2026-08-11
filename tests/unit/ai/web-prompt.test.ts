import assert from "node:assert/strict";
import { buildWebPrompt } from "../../../lib/ai/prompts";

const prompt = buildWebPrompt({
  gridSize: 64,
  minBlocks: 200,
  maxBlocks: 196_608,
  palette: "simple",
  prompt: "A medieval castle with four corner towers",
});

assert.ok(prompt.includes("Grid coordinates are integers in [0, 63]."));
assert.ok(prompt.includes("Center the build around x=32, z=32."));
assert.ok(prompt.includes("Minimum 200 blocks."));
assert.ok(prompt.includes("Maximum 196,608 blocks"));
assert.ok(prompt.includes("- stone: Stone"));
assert.ok(!prompt.includes("mossy_stone_bricks"));
assert.ok(prompt.includes("A medieval castle with four corner towers"));
assert.ok(prompt.includes('"boxes"') && prompt.includes('"lines"') && prompt.includes('"blocks"'));
assert.ok(!prompt.includes("voxel.exec"));
assert.ok(prompt.includes("downloadable file"));

const advancedPrompt = buildWebPrompt({
  gridSize: 128,
  minBlocks: 500,
  maxBlocks: 500_000,
  palette: "advanced",
  prompt: "A locomotive",
});

assert.ok(advancedPrompt.includes("Grid coordinates are integers in [0, 127]."));
assert.ok(advancedPrompt.includes("- mossy_stone_bricks: Mossy Stone Bricks"));

console.log("web prompt checks passed");
