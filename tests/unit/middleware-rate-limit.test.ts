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

  const firstAnonymous = middleware(
    new NextRequest("http://localhost/api/leaderboard/models/anonymous-model-0"),
  );
  assert.equal(firstAnonymous.status, 200);
  assert.match(firstAnonymous.headers.get("set-cookie") ?? "", /mb_rls=/);

  for (let index = 1; index < 18; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/leaderboard/models/anonymous-model-${index}`,
    );
    assert.equal(middleware(request).status, 200);
  }

  const anonymousLimited = middleware(
    new NextRequest("http://localhost/api/leaderboard/models/anonymous-model-18"),
  );
  assert.equal(anonymousLimited.status, 429);

  for (let index = 0; index < 18; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/leaderboard/models/session-model-${index}`,
      { headers: { cookie: "mb_rls=review-session" } },
    );
    assert.equal(middleware(request).status, 200);
  }

  const sessionLimited = middleware(
    new NextRequest("http://localhost/api/leaderboard/models/session-model-18", {
      headers: { cookie: "mb_rls=review-session" },
    }),
  );
  assert.equal(sessionLimited.status, 429);

  console.log("middleware rate-limit contract checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
