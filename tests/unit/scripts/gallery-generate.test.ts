import assert from "node:assert/strict";
import type { ModelKey } from "../../../lib/ai/modelCatalog";
import { planCommunityModels } from "../../../lib/gallery/communityGeneration";

const key = (value: string) => value as ModelKey;
const ranked = ["a", "b", "c", "d", "e"].map((value, index) => ({ key: key(value), rank: index + 1 }));
const costs: Record<string, number | null> = { a: 2, b: 40, c: 0.5, d: null, e: 0.1 };
const costOf = (model: ModelKey) => costs[model] ?? null;
const keys = (plan: { key: ModelKey }[]) => plan.map((model) => model.key);

// top ranked under the cap, unknown costs excluded
assert.deepEqual(keys(planCommunityModels({ ranked, costOf, existing: new Set(), top: 2, maxCostUsd: 3, explicit: [] })), ["a", "c"]);
// already built models are skipped after picking so reruns only fill gaps
assert.deepEqual(keys(planCommunityModels({ ranked, costOf, existing: new Set(["a"]), top: 3, maxCostUsd: 3, explicit: [] })), ["c", "e"]);
// explicit models keep the cap for known costs and allow unknown ones
assert.deepEqual(keys(planCommunityModels({ ranked, costOf, existing: new Set(), top: 10, maxCostUsd: 3, explicit: [key("b"), key("d"), key("e")] })), ["d", "e"]);
// repeated explicit models plan once
assert.deepEqual(keys(planCommunityModels({ ranked, costOf, existing: new Set(), top: 10, maxCostUsd: 3, explicit: [key("e"), key("e"), key("c")] })), ["e", "c"]);

console.log("gallery generate planning checks passed");
