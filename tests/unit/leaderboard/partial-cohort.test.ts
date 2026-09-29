import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Prisma } from "@prisma/client";

const require = createRequire(import.meta.url);
const mock = (path: string, exports: unknown) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
};
const samples = new Map<string, (number | null)[]>([
  ["complete", [100, 300]],
  ["unassigned", [500]],
  ["missing-metadata", [600, null]],
  ["invalid-metadata", [700, 0]],
]);
mock("../../../lib/prisma", { prisma: {
  model: { findMany: async () => [...samples.keys()].map((id) => ({
    id, key: id, provider: "test", displayName: id,
    eloRating: 1500, glickoRd: 100, conservativeRating: 1300,
    shownCount: 0, winCount: 0, lossCount: 0, drawCount: 0, bothBadCount: 0,
  })) },
  modelRankSnapshot: { findFirst: async () => null },
  build: { groupBy: async ({ where }: { where: Prisma.BuildWhereInput }) => {
    assert.equal(where.active, true);
    assert.deepEqual(where.promptId, { in: ["official", "community"] });
    assert.equal(where.gridSize, 256);
    assert.equal(where.palette, "simple");
    assert.equal(where.mode, "precise");
    const measuredOnly = where.blockCount != null;
    if (measuredOnly) assert.deepEqual(where.blockCount, { gt: 0 });
    return [...samples].map(([modelId, values]) => {
      const measured = values.filter((value): value is number => value != null && value > 0);
      return {
        modelId,
        _count: { _all: measuredOnly ? measured.length : values.length },
        _avg: { blockCount: measured.reduce((sum, value) => sum + value, 0) / measured.length },
      };
    });
  } },
} });
mock("../../../lib/arena/stats", {
  ...require("../../../lib/arena/stats"),
  getGlobalBradleyTerrySnapshot: async () => ({ byModelId: new Map() }),
  getLeaderboardDispersionByModelId: async () => new Map(),
});
mock("../../../lib/arena/eligibility", {
  ...require("../../../lib/arena/eligibility"),
  getArenaEligiblePromptIds: async () => ["official", "community"],
});
mock("../../../lib/arena/coverage", { getArenaPairCoverageByKey: async () => new Map() });

async function main() {
  const { getLeaderboardData } = await import("../../../lib/arena/leaderboard");
  const { data } = await getLeaderboardData();
  const benchmark = (key: string) => data.models.find((model) => model.key === key)!.benchmark!;
  assert.equal(benchmark("complete").averageBlocks, 200);
  assert.equal(benchmark("complete").expectedBuildCount, 2);
  assert.equal(benchmark("unassigned").averageBlocks, 500,
    "a community prompt without this model must not suppress its block average");
  assert.equal(benchmark("unassigned").expectedBuildCount, 1);
  for (const key of ["missing-metadata", "invalid-metadata"]) {
    assert.equal(benchmark(key).averageBlocks, null);
    assert.equal(benchmark(key).blockSampleCount, 1);
    assert.equal(benchmark(key).expectedBuildCount, 2,
      "missing or invalid metadata must remain in the expected sample count");
  }
  console.log("leaderboard partial cohort checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
