import assert from "node:assert/strict";
import { BENCHMARK_PROMPT_MAP } from "../../../lib/benchmark/prompts";
import { isCommunityArenaPrompt, pickArenaImportSources } from "../../../lib/gallery/arenaImport";

assert.equal(isCommunityArenaPrompt(BENCHMARK_PROMPT_MAP.castle), false);
assert.equal(isCommunityArenaPrompt("An accurate globe"), true);

const example = (id: string, modelKey: string | null) => ({ id, customBuild: { modelKey } });
assert.deepEqual(
  pickArenaImportSources([
    example("first-astra", "openai_gpt_6_astra"),
    example("flash", "gemini_3_8_flash"),
    example("second-astra", "openai_gpt_6_astra"),
    example("unknown", null),
  ]).map(({ id }) => id),
  ["first-astra", "flash"],
);

console.log("gallery arena import checks passed");
