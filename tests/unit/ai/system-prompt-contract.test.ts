import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_BLOCKS_BY_GRID, MIN_BLOCKS_BY_GRID } from "../../../lib/ai/limits";
import { buildSystemPrompt } from "../../../lib/ai/prompts";
import { getPalette } from "../../../lib/blocks/palettes";

// captured from the original prompts before adding grid sizes and palette entries
// normalize only the palette variables so wording and existing numeric settings stay fixed
const expected = {
  64: "bb729aed54a4c3ec59c7b8fe09560da32f8187073f6d42e04cd51ebffe0523bb",
  256: "81c193094f6245417262697e9cf60e6d47263dbe836c5d2ce5369a9612d45d6b",
  512: "093c8cac027773fc75eab08730d6110f9c2c35afebdbd0c15e38b555f78f5dc4",
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
