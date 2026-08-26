import assert from "node:assert/strict";
import {
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryAttribution,
  galleryIdentityHmac,
  isGalleryContributionVisible,
  normalizeGalleryNickname,
  normalizeGalleryPrompt,
  normalizeGalleryPromptIdentity,
  publicGalleryTextError,
  resolveGalleryModelLabel,
} from "../../../lib/gallery/policy";
import { hashVoteSession } from "../../../lib/voteBlock";

assert.equal(normalizeGalleryPrompt("  A tiny observatory  "), "A tiny observatory");
assert.equal(normalizeGalleryPrompt("Castle"), "Castle");
assert.notEqual(normalizeGalleryPrompt("Castle"), normalizeGalleryPrompt("castle"));
assert.equal(normalizeGalleryPromptIdentity("  Circle  "), normalizeGalleryPromptIdentity("circle"));

assert.deepEqual(normalizeGalleryNickname("  Mine Builder  "), {
  display: "Mine Builder",
  normalized: "mine builder",
});
const blockedInflection = String.fromCodePoint(102, 117, 99, 107, 105, 110, 103);
assert.equal(publicGalleryTextError("A quiet garden"), null);
assert.equal(publicGalleryTextError(`A monument ${blockedInflection}`), "blocked_language");
assert.equal(publicGalleryTextError("shellfish monument"), null);
assert.equal(publicGalleryTextError("classic stonework"), null);

assert.equal(
  isGalleryContributionVisible({
    removedAt: null,
    adminHiddenAt: null,
    contributorSuspendedAt: new Date(),
    selectedAt: new Date(),
  }),
  true,
);
assert.equal(
  isGalleryContributionVisible({
    removedAt: null,
    adminHiddenAt: null,
    contributorSuspendedAt: new Date(),
    selectedAt: null,
  }),
  false,
);
assert.equal(
  isGalleryContributionVisible({
    removedAt: new Date(),
    adminHiddenAt: null,
    contributorSuspendedAt: null,
    selectedAt: new Date(),
  }),
  false,
);

assert.equal(galleryAttribution({ postAnonymously: true, publicNickname: "Builder" }), "Anonymous");
assert.equal(galleryAttribution({ postAnonymously: false, publicNickname: "Builder" }), "Builder");
assert.equal(galleryAttribution({ postAnonymously: false, publicNickname: null }), "Anonymous");

assert.equal(resolveGalleryModelLabel({ kind: "catalog", displayName: "Claude" }), "Claude");
assert.equal(
  resolveGalleryModelLabel({ kind: "openrouter", displayName: "Hidden", modelId: "vendor/model" }),
  "vendor/model",
);
assert.equal(
  resolveGalleryModelLabel({ kind: "custom", displayName: "Local model", modelId: "secret" }),
  "Custom · Local model · secret",
);

const cursor = encodeGalleryCursor({ score: 4, publishedAt: new Date("2026-08-25T12:00:00Z"), id: "abc" });
assert.deepEqual(decodeGalleryCursor(cursor), {
  score: 4,
  publishedAt: new Date("2026-08-25T12:00:00.000Z"),
  id: "abc",
});
assert.equal(decodeGalleryCursor("not-a-cursor"), null);

assert.equal(galleryIdentityHmac("same", "secret"), galleryIdentityHmac("same", "secret"));
assert.notEqual(galleryIdentityHmac("same", "secret"), galleryIdentityHmac("other", "secret"));

const originalVoteSecret = process.env.VOTE_BLOCK_HMAC_SECRET;
const originalAdminToken = process.env.ADMIN_TOKEN;
try {
  delete process.env.VOTE_BLOCK_HMAC_SECRET;
  process.env.ADMIN_TOKEN = "vote-block-fallback-test";
  assert.equal(
    hashVoteSession("session"),
    galleryIdentityHmac("session:session", "vote-block-fallback-test"),
  );
} finally {
  if (originalVoteSecret === undefined) delete process.env.VOTE_BLOCK_HMAC_SECRET;
  else process.env.VOTE_BLOCK_HMAC_SECRET = originalVoteSecret;
  if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = originalAdminToken;
}

console.log("gallery policy checks passed");
