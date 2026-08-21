import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { middleware } from "../../middleware";

async function main() {
  const ip = "203.0.113.42";

  for (let index = 0; index < 18; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/leaderboard/models/model-${index}`,
      { headers: { "x-forwarded-for": ip } },
    );
    assert.equal(middleware(request).status, 200);
  }

  const limited = middleware(
    new NextRequest("http://localhost/api/leaderboard/models/model-18", {
      headers: { "x-forwarded-for": ip },
    }),
  );
  assert.equal(limited.status, 429);

  console.log("middleware rate-limit contract checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
