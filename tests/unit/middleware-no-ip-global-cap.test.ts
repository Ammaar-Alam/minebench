import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { middleware } from "../../middleware";

async function main() {
  delete process.env.ARENA_TRUST_X_FORWARDED_FOR;
  delete process.env.VERCEL;
  process.env.ARENA_FORWARDED_IP_FALLBACK = "1";

  for (let index = 0; index < 180; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/leaderboard/models/global-model-${index}`,
      {
        headers: {
          cookie: `mb_rls=rotating-session-${index}`,
          "user-agent": `rotating-client-${index}`,
          "accept-language": `en-${index}`,
          "x-forwarded-for": `198.51.100.${index % 255}`,
        },
      },
    );
    assert.equal(middleware(request).status, 200);
  }

  const limited = middleware(
    new NextRequest("http://localhost/api/leaderboard/models/global-model-180", {
      headers: {
        cookie: "mb_rls=rotating-session-180",
        "user-agent": "rotating-client-180",
        "accept-language": "en-180",
        "x-forwarded-for": "198.51.100.180",
      },
    }),
  );
  assert.equal(limited.status, 429);

  console.log("middleware no-IP global cap checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
