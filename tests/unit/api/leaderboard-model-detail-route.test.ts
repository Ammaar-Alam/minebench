import assert from "node:assert/strict";

import { createModelDetailResponse } from "../../../app/api/leaderboard/models/modelDetailResponse";
import type { ModelDetailStats } from "../../../lib/arena/stats";

const detail = {
  model: {
    key: "test-model",
    provider: "test",
    displayName: "Test Model",
    eloRating: 1500,
    ratingDeviation: 100,
    rankScore: 1300,
    confidence: 75,
    stability: "Established",
    shownCount: 12,
    winCount: 6,
    lossCount: 4,
    drawCount: 1,
    bothBadCount: 1,
  },
  summary: {
    meanScore: 0.6,
    scoreVariance: 0.04,
    scoreSpread: 0.4,
    consistency: 0.8,
    coveredPrompts: 8,
    activePrompts: 10,
    promptCoverage: 0.8,
    sampledPrompts: 8,
    sampledVotes: 11,
    totalVotes: 12,
    decisiveVotes: 10,
    winRate: 0.6,
    recentForm: 0.7,
    recentDelta: 0.1,
    qualityFloorScore: 0.4,
  },
  prompts: [],
  opponents: [],
} satisfies ModelDetailStats;

async function main() {
  const missing = createModelDetailResponse(null);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missing.json(), { error: "Model not found" });

  const response = createModelDetailResponse(detail);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
  );
  assert.deepEqual(await response.json(), detail);

  console.log("leaderboard model detail route contract checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
