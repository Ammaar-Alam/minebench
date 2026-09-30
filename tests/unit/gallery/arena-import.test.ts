import assert from "node:assert/strict";
import { BENCHMARK_PROMPT_MAP } from "../../../lib/benchmark/prompts";
import { galleryArenaCopyPathWhere, isCommunityArenaPrompt, pickArenaImportSources } from "../../../lib/gallery/arenaImport";

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

// moderation finds copies made under any prompt setup
const copyPath = galleryArenaCopyPathWhere("cb1");
for (const path of ["gallery/p/model-cb1-g256-simple-precise.json.gz", "gallery/p/model-cb1-g512-advanced-precise.json.gz"]) {
  assert.ok(path.startsWith(copyPath.startsWith) && path.includes(copyPath.contains), path);
}
assert.ok(!"gallery/p/model-cb10-g256-simple-precise.json.gz".includes(copyPath.contains));

console.log("gallery arena import checks passed");
