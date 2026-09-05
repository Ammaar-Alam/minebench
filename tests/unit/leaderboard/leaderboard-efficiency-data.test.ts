import assert from "node:assert/strict";
import { createLeaderboardBenchmark } from "../../../lib/arena/leaderboard";

const tracked = createLeaderboardBenchmark("openai_gpt_5_6_sol", 15, {
  averageBlocks: 1250,
  blockSampleCount: 15,
});

assert.equal(tracked.averageCostUsd, 710.82 / 15);
assert.equal(tracked.costEstimated, false);
assert.equal(tracked.averageTimeMs, 1_516_200);
assert.equal(tracked.averageBlocks, 1250);
assert.equal(tracked.blockSampleCount, 15);
assert.equal(tracked.expectedBuildCount, 15);

const incomplete = createLeaderboardBenchmark("openai_gpt_5_6_sol", 15, {
  averageBlocks: 1250,
  blockSampleCount: 14,
});

assert.equal(incomplete.averageBlocks, null);
assert.equal(incomplete.blockSampleCount, 14);

const zeroBlocks = createLeaderboardBenchmark("unknown_model", 1, {
  averageBlocks: 0,
  blockSampleCount: 1,
});

assert.deepEqual(zeroBlocks, {
  averageCostUsd: null,
  costEstimated: false,
  averageTimeMs: null,
  averageBlocks: null,
  blockSampleCount: 1,
  expectedBuildCount: 1,
});

console.log("leaderboard efficiency data checks passed");
