import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createArenaMatchupToken,
  parseArenaMatchupToken,
} from "../../../lib/arena/matchupToken";
import { normalizeArenaBuildChecksum } from "../../../lib/arena/buildChecksum";

const signingSecret = "arena-matchup-token-test-secret";
const originalSigningSecret = process.env.ARENA_MATCHUP_SIGNING_SECRET;

try {
  process.env.ARENA_MATCHUP_SIGNING_SECRET = signingSecret;

  assert.equal(normalizeArenaBuildChecksum(` ${"a".repeat(64)} `), "a".repeat(64));
  assert.equal(normalizeArenaBuildChecksum("not-a-checksum"), null);
  assert.equal(normalizeArenaBuildChecksum("g".repeat(64)), null);
  assert.throws(
    () =>
      createArenaMatchupToken({
        promptId: "prompt-1",
        modelAId: "model-a",
        modelBId: "model-b",
        buildAId: "build-a",
        buildBId: "build-b",
        buildAChecksum: "not-a-checksum",
        buildBChecksum: "b".repeat(64),
      }),
    /must be SHA-256 values/,
  );

  const token = createArenaMatchupToken({
    promptId: "prompt-1",
    modelAId: "model-a",
    modelBId: "model-b",
    buildAId: "build-a",
    buildBId: "build-b",
    buildAChecksum: "a".repeat(64),
    buildBChecksum: "b".repeat(64),
    samplingLane: "coverage",
    samplingReason: "test",
  });
  const parsed = parseArenaMatchupToken(token);
  assert.ok(parsed);
  assert.equal(parsed.promptId, "prompt-1");
  assert.equal(parsed.buildAChecksum, "a".repeat(64));
  assert.equal(parsed.buildBChecksum, "b".repeat(64));
  assert.ok(Number.isInteger(parsed.issuedAt));

  const [encodedPayload] = token.split(".");
  assert.ok(encodedPayload);
  const legacyPayload = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  delete legacyPayload.ca;
  delete legacyPayload.cb;
  const encodedLegacyPayload = Buffer.from(JSON.stringify(legacyPayload), "utf8").toString(
    "base64url",
  );
  const legacySignature = createHmac("sha256", signingSecret)
    .update(encodedLegacyPayload)
    .digest("base64url");
  assert.equal(
    parseArenaMatchupToken(`${encodedLegacyPayload}.${legacySignature}`),
    null,
    "tokens without build versions must be rejected",
  );

  assert.equal(parseArenaMatchupToken(`${token}x`), null, "tampered tokens must be rejected");
  console.log("arena matchup token checks passed");
} finally {
  if (originalSigningSecret === undefined) delete process.env.ARENA_MATCHUP_SIGNING_SECRET;
  else process.env.ARENA_MATCHUP_SIGNING_SECRET = originalSigningSecret;
}
