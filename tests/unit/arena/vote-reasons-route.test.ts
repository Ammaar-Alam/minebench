import assert from "node:assert/strict";

import { POST } from "../../../app/api/arena/vote/reasons/route";

function post(body: unknown) {
  return POST(
    new Request("http://localhost:3000/api/arena/vote/reasons", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function main() {
  const originalSecret = process.env.ARENA_MATCHUP_SIGNING_SECRET;
  try {
    process.env.ARENA_MATCHUP_SIGNING_SECRET = "vote-reasons-route-test-secret";
    const matchupId = "00000000-0000-4000-8000-000000000000";

    const unknown = await post({ matchupId, reasons: ["bigger"] });
    assert.equal(unknown.status, 400);

    // an unsigned matchup id matches no vote, and the caller cannot tell
    const unsigned = await post({ matchupId, reasons: ["clearer", "better_style"] });
    assert.equal(unsigned.status, 200);
    assert.deepEqual(await unsigned.json(), { ok: true });
    console.log("arena vote reasons route checks passed");
  } finally {
    if (originalSecret === undefined) delete process.env.ARENA_MATCHUP_SIGNING_SECRET;
    else process.env.ARENA_MATCHUP_SIGNING_SECRET = originalSecret;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
