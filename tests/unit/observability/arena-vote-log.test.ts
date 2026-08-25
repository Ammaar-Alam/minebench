import assert from "node:assert/strict";
import { logArenaVoteRequest } from "../../../lib/observability/arenaVoteLog";

const messages: string[] = [];
const originalInfo = console.info;
const request = new Request("https://minebench.ai/api/arena/vote", {
  headers: {
    "user-agent": "MineBench test agent",
    "x-real-ip": "203.0.113.4",
    "x-vercel-id": "iad1::request-123",
    "x-vercel-ip-city": "New%20York",
    "x-vercel-ip-country": "US",
    "x-vercel-ip-country-region": "NY",
    "x-vercel-ip-postal-code": "10001",
    "x-vercel-ip-latitude": "40.7128",
    "x-vercel-ip-longitude": "-74.0060",
  },
});
const input = {
  outcome: "accepted",
  voteId: "vote-123",
  choice: "A",
  authenticated: true,
  owned: true,
  scope: "public",
} as const;

console.info = (message?: unknown) => messages.push(String(message));

try {
  logArenaVoteRequest(request, input);
} finally {
  console.info = originalInfo;
}

assert.equal(messages.length, 1);
const event = JSON.parse(messages[0]) as Record<string, unknown>;
assert.equal(event.event, "arena_vote");
assert.equal(event.ip, "203.0.113.4");
assert.equal(event.city, "New York");
assert.equal(event.country, "US");
assert.equal(event.country_region, "NY");
assert.equal(event.postal_code, "10001");
assert.equal(event.latitude, "40.7128");
assert.equal(event.longitude, "-74.0060");
assert.equal(event.edge_region, "iad1");
assert.equal(event.voteId, "vote-123");
assert.equal(event.authenticated, true);
assert.equal("userId" in event, false);
assert.equal("sessionId" in event, false);
assert.equal("email" in event, false);

console.info = () => {
  throw new Error("log transport unavailable");
};
try {
  assert.doesNotThrow(() => logArenaVoteRequest(request, input));
} finally {
  console.info = originalInfo;
}

console.log("arena vote structured log checks passed");
