import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_BLOCKS_BY_GRID, MIN_BLOCKS_BY_GRID } from "../../../lib/ai/limits";
import { buildSystemPrompt } from "../../../lib/ai/prompts";
import { getPalette } from "../../../lib/blocks/palettes";

// captured from the master benchmark prompt with internal build planning
// normalize only the palette variables so wording and existing numeric settings stay fixed
const expected = {
  64: "60bcff42143a1cd2dc465da819a39ee7dbbc3258d2b96a9efb6c281ff8ef93a8",
  256: "2730a7cb773972d7f83f3b477d98f4b2065c2ae22189704c88d6f2846b2bdc96",
  512: "6383a01fb68ca45120d7dcb23284adb7485421753341ea46155aaa723fee882d",
};

for (const gridSize of [64, 256, 512] as const) {
  for (const palette of ["simple", "advanced"] as const) {
    const prompt = buildSystemPrompt({
      gridSize,
      palette,
      maxBlocks: MAX_BLOCKS_BY_GRID[gridSize],
      minBlocks: MIN_BLOCKS_BY_GRID[gridSize],
    });
    const normalized = prompt
      .replace(getPalette(palette).map((block) => block.id).join(", "), "")
      .replace('"palette":"advanced"', '"palette":"simple"');
    assert.equal(createHash("sha256").update(normalized).digest("hex"), expected[gridSize]);
  }
}

console.log("system prompt contract checks passed");
