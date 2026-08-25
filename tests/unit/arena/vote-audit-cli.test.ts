import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVoteAuditArgs } from "../../../scripts/audit-account-votes";

assert.deepEqual(
  parseVoteAuditArgs(["node", "script", "--email", "User@Example.com", "--limit", "25", "--json"]),
  {
    beforeVoteId: null,
    help: false,
    json: true,
    limit: 25,
    selector: { kind: "email", value: "user@example.com" },
    sessionId: null,
  },
);

assert.deepEqual(
  parseVoteAuditArgs([
    "node",
    "script",
    "--user-id",
    "550e8400-e29b-41d4-a716-446655440000",
    "--session-id",
    "session-1",
    "--before-vote",
    "vote-1",
  ]),
  {
    beforeVoteId: "vote-1",
    help: false,
    json: false,
    limit: 50,
    selector: { kind: "userId", value: "550e8400-e29b-41d4-a716-446655440000" },
    sessionId: "session-1",
  },
);

assert.throws(
  () => parseVoteAuditArgs(["node", "script", "--email", "a@example.com", "--vote-id", "vote"]),
  /exactly one/,
);
assert.throws(() => parseVoteAuditArgs(["node", "script", "--limit", "101"]), /1 to 100/);
assert.throws(() => parseVoteAuditArgs(["node", "script", "--all"]), /expects a value|Unknown option/);
assert.deepEqual(parseVoteAuditArgs(["node", "script", "--help"]), {
  beforeVoteId: null,
  help: true,
  json: false,
  limit: 50,
  selector: null,
  sessionId: null,
});

const script = readFileSync("scripts/audit-account-votes.ts", "utf8");
assert.match(script, /stealthVariantId: null/);
assert.doesNotMatch(script, /prisma\.[a-zA-Z]+\.(?:create|update|delete|upsert)/);

console.log("public vote audit CLI checks passed");
