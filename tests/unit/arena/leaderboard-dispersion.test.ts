import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mock = (path: string, exports: unknown) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
};

const pairVotes = [
  { promptId: "p1", modelAId: "a", modelBId: "b", pointsA: 6, pointsB: 4, total: 10 },
  { promptId: "p1", modelAId: "b", modelBId: "a", pointsA: 2, pointsB: 8, total: 10 },
  { promptId: "p2", modelAId: "a", modelBId: "b", pointsA: 5, pointsB: 5, total: 10 },
  { promptId: "p3", modelAId: "a", modelBId: "b", pointsA: 7.5, pointsB: 2.5, total: 10 },
  { promptId: "community", modelAId: "a", modelBId: "b", pointsA: 10, pointsB: 0, total: 10 },
];
let aggregateQueries = 0;

mock("../../../lib/prisma", { prisma: {
  $queryRaw: async () => {
    aggregateQueries += 1;
    return pairVotes;
  },
  model: { findMany: async () => ["a", "b"].map((id) => ({ id, key: id, provider: "test", displayName: id })) },
  prompt: { findMany: async () => ["p1", "p2", "p3", "community"].map((id) => ({ id, text: id })) },
  build: { groupBy: async () => ["a", "b"].map((modelId) => ({ modelId, _count: { _all: 3 } })) },
} });
mock("../../../lib/arena/eligibility", {
  ...require("../../../lib/arena/eligibility"),
  getArenaEligiblePromptIds: async () => ["p1", "p2", "p3", "community"],
});
mock("../../../lib/gallery/arenaImport", { isCommunityArenaPrompt: (text: string) => text === "community" });

async function main() {
  const { getLeaderboardDispersionByModelId } = await import("../../../lib/arena/stats");
  const dispersion = await getLeaderboardDispersionByModelId();

  assert.equal(aggregateQueries, 1, "rankings and dispersion must share one vote aggregate");

  const a = dispersion.get("a")!;
  const b = dispersion.get("b")!;
  assert.equal(a.sampledPrompts, 3, "community prompts stay out of dispersion");
  assert.equal(a.sampledVotes, 40, "both orderings of a pair count toward the prompt");
  assert.ok(Math.abs(a.meanScore! - 0.65) < 1e-12);
  assert.ok(Math.abs(b.meanScore! - 0.35) < 1e-12);
  assert.ok(Math.abs(a.scoreVariance! - (0.05 ** 2 + 0.15 ** 2 + 0.1 ** 2) / 3) < 1e-12);

  console.log("leaderboard dispersion checks passed");
}

void main();
