import assert from "node:assert/strict";
import {
  assertCustomBuildPublicId,
  generateCustomBuildPublicId,
  isCustomBuildPublicId,
} from "../../../lib/custom-builds/ids";
import {
  decryptProviderKey,
  encryptProviderKey,
} from "../../../lib/custom-builds/secrets";
import { redactSensitiveText } from "../../../lib/custom-builds/sanitize";
import { getCustomBuildArtifactPath } from "../../../lib/custom-builds/storage";

function main() {
  const id = generateCustomBuildPublicId();
  assert.match(id, /^cb_[A-Za-z0-9_-]{24}$/);
  assert.equal(isCustomBuildPublicId(id), true);
  assert.equal(assertCustomBuildPublicId(id), id);
  assert.equal(isCustomBuildPublicId("cb_1"), false);
  assert.equal(isCustomBuildPublicId("cb_123456789012345678901234/.."), false);
  assert.equal(isCustomBuildPublicId("123"), false);
  assert.throws(() => assertCustomBuildPublicId("../cb_123456789012345678901234"), /Invalid custom build id/);

  process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = "unit-test-secret-material";
  const encrypted = encryptProviderKey("sk-or-v1-test-secret-value", {
    provider: "openrouter",
  });
  assert.equal(encrypted.provider, "openrouter");
  assert.notEqual(encrypted.keyCiphertext, "sk-or-v1-test-secret-value");
  assert.equal(decryptProviderKey(encrypted), "sk-or-v1-test-secret-value");

  process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = "different-secret-material";
  assert.throws(() => decryptProviderKey(encrypted), /Failed to decrypt provider key/);

  const redacted = redactSensitiveText(
    "OpenRouter failed with Authorization: Bearer sk-or-v1-test-secret-value and api_key=sk-live-abc123456789",
  );
  assert.equal(redacted.includes("sk-or-v1-test-secret-value"), false);
  assert.equal(redacted.includes("sk-live-abc123456789"), false);
  assert.match(redacted, /\[redacted]/);

  const buildPath = getCustomBuildArtifactPath({
    publicId: id,
    kind: "build_json",
    sha256: "a".repeat(64),
  });
  assert.equal(
    buildPath,
    `custom-builds/v1/${id}/build/build-${"a".repeat(64)}.json.gz`,
  );

  const exportPath = getCustomBuildArtifactPath({
    publicId: id,
    kind: "glb",
    sourceBuildSha256: "b".repeat(64),
  });
  assert.equal(
    exportPath,
    `custom-builds/v1/${id}/exports/build-${"b".repeat(64)}.glb`,
  );
  assert.throws(
    () => getCustomBuildArtifactPath({ publicId: "../escape", kind: "build_json", sha256: "a".repeat(64) }),
    /Invalid custom build id/,
  );
}

main();
