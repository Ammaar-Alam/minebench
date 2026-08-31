import assert from "node:assert/strict";
import {
  galleryRetestPublicId,
  parseGalleryImportArgs,
  resolveGalleryImportSpec,
} from "../../../scripts/import-gallery-retest";

const parsed = parseGalleryImportArgs([
  "--prompt",
  "steampunk",
  "--model",
  "gemini-3-1-pro",
]);
assert.equal(parsed.help, false);
if (parsed.help) throw new Error("Expected import arguments.");
assert.deepEqual(parsed, {
  help: false,
  promptSlug: "steampunk",
  model: "gemini-3-1-pro",
  confirmed: false,
});
const confirmed = parseGalleryImportArgs([
  "--prompt",
  "steampunk",
  "--model",
  "gemini-3-1-pro",
  "--yes",
]);
assert.equal(confirmed.help ? false : confirmed.confirmed, true);
assert.equal(
  resolveGalleryImportSpec(parsed, "/repo/uploads").filePath,
  "/repo/uploads/steampunk/steampunk-gemini-3-1-pro.json",
);

assert.deepEqual(parseGalleryImportArgs(["--help"]), { help: true });
assert.throws(
  () => {
    const invalid = parseGalleryImportArgs(["--prompt", "steampunk", "--model", "not-a-model"]);
    if (invalid.help) throw new Error("Expected import arguments.");
    resolveGalleryImportSpec(invalid);
  },
  /Unknown catalog model/,
);
assert.throws(
  () => resolveGalleryImportSpec({ ...parsed, promptSlug: "custom-prompt" }),
  /Unknown official prompt/,
);
assert.throws(
  () => parseGalleryImportArgs(["--prompt", "steampunk", "--model"]),
  /--model needs a value/,
);

const identity = {
  publisherId: "00000000-0000-4000-8000-000000000001",
  promptSlug: "steampunk",
  modelKey: "gemini_3_1_pro",
  sourceArtifactSha256: "a".repeat(64),
  completedAt: "2026-08-31T04:35:00.445Z",
};
const publicId = galleryRetestPublicId(identity);
assert.match(publicId, /^cb_[A-Za-z0-9_-]{24}$/);
assert.equal(galleryRetestPublicId(identity), publicId);
assert.notEqual(
  galleryRetestPublicId({ ...identity, sourceArtifactSha256: "b".repeat(64) }),
  publicId,
);
assert.notEqual(
  galleryRetestPublicId({ ...identity, completedAt: "2026-09-01T04:35:00.445Z" }),
  publicId,
);

console.log("Gallery retest import argument checks passed");
