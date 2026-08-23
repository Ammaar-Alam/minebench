import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { middleware } from "../../middleware";

async function main() {
  process.env.ARENA_TRUST_X_FORWARDED_FOR = "1";
  const ip = "203.0.113.42";

  for (let index = 0; index < 18; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/leaderboard/models/model-${index}`,
      { headers: { "x-real-ip": ip } },
    );
    assert.equal((await middleware(request)).status, 200);
  }

  const limited = await middleware(
    new NextRequest("http://localhost/api/leaderboard/models/model-18", {
      headers: { "x-real-ip": ip },
    }),
  );
  assert.equal(limited.status, 429);

  const firstAnonymous = await middleware(
    new NextRequest("http://localhost/api/leaderboard/models/anonymous-model-0"),
  );
  assert.equal(firstAnonymous.status, 200);
  assert.match(firstAnonymous.headers.get("set-cookie") ?? "", /mb_rls=/);

  for (let index = 1; index < 18; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/leaderboard/models/anonymous-model-${index}`,
    );
    assert.equal((await middleware(request)).status, 200);
  }

  const anonymousLimited = await middleware(
    new NextRequest("http://localhost/api/leaderboard/models/anonymous-model-18"),
  );
  assert.equal(anonymousLimited.status, 429);

  for (let index = 0; index < 19; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/leaderboard/models/shared-model-${index}`,
      {
        headers: {
          cookie: `mb_rls=review-session-${index}`,
          "user-agent": "shared-client",
        },
      },
    );
    assert.equal((await middleware(request)).status, 200);
  }

  for (let index = 0; index < 18; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/leaderboard/models/session-model-${index}`,
      {
        headers: {
          cookie: "mb_rls=review-session",
          "user-agent": "strict-session-client",
        },
      },
    );
    assert.equal((await middleware(request)).status, 200);
  }

  const sessionLimited = await middleware(
    new NextRequest("http://localhost/api/leaderboard/models/session-model-18", {
      headers: {
        cookie: "mb_rls=review-session",
        "user-agent": "strict-session-client",
      },
    }),
  );
  assert.equal(sessionLimited.status, 429);

  const labIp = "203.0.113.84";
  for (let index = 0; index < 18; index += 1) {
    const request = new NextRequest(
      `http://localhost/api/lab/organizations/test-${index}/builds/private-build-${index}`,
      { headers: { "x-real-ip": labIp } },
    );
    assert.equal((await middleware(request)).status, 200);
  }
  const labLimited = await middleware(
    new NextRequest("http://localhost/api/lab/organizations/test-18/builds/private-build-18", {
      headers: { "x-real-ip": labIp },
    }),
  );
  assert.equal(labLimited.status, 429);

  const contactSessionHeaders = {
    cookie: "mb_rls=contact-session",
    "user-agent": "contact-form-client",
  };
  for (let index = 0; index < 3; index += 1) {
    const response = await middleware(
      new NextRequest("http://localhost/api/contact", {
        method: "POST",
        headers: contactSessionHeaders,
      }),
    );
    assert.equal(response.status, 200);
  }
  const contactSessionLimited = await middleware(
    new NextRequest("http://localhost/api/contact", {
      method: "POST",
      headers: contactSessionHeaders,
    }),
  );
  assert.equal(contactSessionLimited.status, 429);
  assert.ok(Number(contactSessionLimited.headers.get("retry-after")) > 3_500);

  const contactIp = "203.0.113.119";
  for (let index = 0; index < 10; index += 1) {
    const response = await middleware(
      new NextRequest("http://localhost/api/contact", {
        method: "POST",
        headers: {
          cookie: `mb_rls=contact-ip-session-${index}`,
          "x-real-ip": contactIp,
        },
      }),
    );
    assert.equal(response.status, 200);
  }
  const contactIpLimited = await middleware(
    new NextRequest("http://localhost/api/contact", {
      method: "POST",
      headers: {
        cookie: "mb_rls=contact-ip-session-10",
        "x-real-ip": contactIp,
      },
    }),
  );
  assert.equal(contactIpLimited.status, 429);

  console.log("middleware rate-limit contract checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
