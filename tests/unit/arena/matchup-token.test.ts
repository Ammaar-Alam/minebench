import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createArenaBuildAccessToken,
  createArenaMatchupToken,
  parseArenaBuildAccessToken,
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
  assert.equal(parsed.stealthVariantId, undefined);
  assert.ok(token.startsWith("v2."));
  assert.equal(token.includes("model-a"), false, "encrypted tokens must not expose model ids");

  const legacyPayload: Record<string, unknown> = {
    i: "legacy-matchup",
    p: "prompt-1",
    ma: "model-a",
    mb: "model-b",
    ba: "build-a",
    bb: "build-b",
    ca: "a".repeat(64),
    cb: "b".repeat(64),
    t: Date.now(),
  };
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

  const stealthToken = createArenaMatchupToken({
    promptId: "prompt-1",
    modelAId: "private-model",
    modelBId: "model-b",
    buildAId: "private-build",
    buildBId: "build-b",
    buildAChecksum: "c".repeat(64),
    buildBChecksum: "b".repeat(64),
    stealthVariantId: "variant-1",
  });
  assert.equal(parseArenaMatchupToken(stealthToken)?.stealthVariantId, "variant-1");
  assert.equal(stealthToken.includes("variant-1"), false);

  const buildAccessToken = createArenaBuildAccessToken({
    buildId: "private-build",
    checksum: "c".repeat(64),
  });
  const parsedBuildAccess = parseArenaBuildAccessToken(buildAccessToken);
  assert.ok(parsedBuildAccess);
  assert.equal(parsedBuildAccess.buildId, "private-build");
  assert.equal(parsedBuildAccess.checksum, "c".repeat(64));
  assert.ok(Number.isInteger(parsedBuildAccess.issuedAt));
  assert.ok(buildAccessToken.startsWith("b1."));
  assert.equal(buildAccessToken.includes("private-build"), false);
  assert.equal(buildAccessToken.includes("c".repeat(64)), false);
  assert.equal(parseArenaBuildAccessToken(`${buildAccessToken}x`), null);

  assert.equal(parseArenaMatchupToken(`${token}x`), null, "tampered tokens must be rejected");
  console.log("arena matchup token checks passed");
} finally {
  if (originalSigningSecret === undefined) delete process.env.ARENA_MATCHUP_SIGNING_SECRET;
  else process.env.ARENA_MATCHUP_SIGNING_SECRET = originalSigningSecret;
}
