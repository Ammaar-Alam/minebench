import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { POST } from "../../../app/api/arena/vote/route";

const voteRouteSource = readFileSync("app/api/arena/vote/route.ts", "utf8");
assert.match(voteRouteSource, /BTRIM\(build_[ab]\."voxelSha256"\)/);
assert.match(
  voteRouteSource,
  /FOR SHARE OF build_a, build_b, model_a, model_b/,
  "vote validation must lock the checked build and model rows until the write commits",
);

async function main() {
  const originalSecret = process.env.ARENA_MATCHUP_SIGNING_SECRET;
  try {
    process.env.ARENA_MATCHUP_SIGNING_SECRET = "vote-route-token-test-secret";
    const response = await POST(
      new Request("http://localhost:3000/api/arena/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          matchupId: "00000000-0000-4000-8000-000000000000",
          choice: "A",
        }),
      }),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Matchup not found" });
    console.log("arena vote route signed-token checks passed");
  } finally {
    if (originalSecret === undefined) delete process.env.ARENA_MATCHUP_SIGNING_SECRET;
    else process.env.ARENA_MATCHUP_SIGNING_SECRET = originalSecret;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
