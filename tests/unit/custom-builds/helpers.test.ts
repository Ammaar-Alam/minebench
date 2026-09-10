import assert from "node:assert/strict";
import type { VoxelBuild } from "../../../lib/voxel/types";
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
import {
  decodeAndVerifyCustomBuildArtifactText,
  gzipBytes,
  jsonBytes,
  sha256Hex,
  uploadAndRecordCustomBuildArtifact,
  writeCanonicalBuildArtifact,
} from "../../../lib/custom-builds/artifacts";
import {
  deleteCustomBuildArtifact,
  downloadCustomBuildArtifactBytes,
  getCustomBuildArtifactPath,
  uploadCustomBuildArtifact,
  uploadCustomBuildArtifactFile,
} from "../../../lib/custom-builds/storage";

async function main() {
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
    "OpenRouter failed at https://private.example/v1/chat?token=opaque with Authorization: Bearer sk-or-v1-test-secret-value and api_key=sk-live-abc123456789",
  );
  assert.equal(redacted.includes("sk-or-v1-test-secret-value"), false);
  assert.equal(redacted.includes("sk-live-abc123456789"), false);
  assert.equal(redacted.includes("private.example"), false);
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

  const canonicalText = JSON.stringify({ version: "1.0", blocks: [] });
  const canonicalBytes = jsonBytes(JSON.parse(canonicalText));
  const compressedBytes = gzipBytes(canonicalBytes);
  const storedSha256 = sha256Hex(compressedBytes);
  const sourceSha256 = sha256Hex(canonicalText);
  assert.equal(
    decodeAndVerifyCustomBuildArtifactText({
      bytes: compressedBytes,
      encoding: "gzip",
      storedSha256,
      sourceSha256,
    }),
    canonicalText,
  );
  assert.equal(
    decodeAndVerifyCustomBuildArtifactText({
      bytes: canonicalBytes,
      encoding: "gzip",
      storedSha256,
      sourceSha256,
    }),
    canonicalText,
    "gzip-marked objects already decoded by fetch should verify against the source checksum",
  );
  assert.throws(
    () => decodeAndVerifyCustomBuildArtifactText({
      bytes: canonicalBytes,
      encoding: "gzip",
      storedSha256,
      sourceSha256: "f".repeat(64),
    }),
    /source checksum does not match/,
  );

  const originalBucket = process.env.CUSTOM_BUILD_STORAGE_BUCKET;
  const originalStorageDir = process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR;
  const canonicalBuild: VoxelBuild = {
    version: "1.0",
    blocks: [
      { x: 1, y: 2, z: 3, type: "stone" },
      { x: 4, y: 5, z: 6, type: "oak_planks" },
    ],
  };
  const streamed = await writeCanonicalBuildArtifact(canonicalBuild);
  try {
    const { readFile } = await import("node:fs/promises");
    const stored = new Uint8Array(await readFile(streamed.filePath));
    const expected = JSON.stringify({
      version: "1.0",
      blocks: [
        { x: 1, y: 2, z: 3, type: "stone" },
        { x: 4, y: 5, z: 6, type: "oak_planks" },
      ],
    });
    assert.equal(streamed.byteSize, Buffer.byteLength(expected));
    assert.equal(streamed.storedByteSize, stored.byteLength);
    assert.equal(streamed.sourceSha256, sha256Hex(expected));
    assert.equal(streamed.sha256, sha256Hex(stored));
    assert.equal(
      decodeAndVerifyCustomBuildArtifactText({
        bytes: stored,
        encoding: "gzip",
        storedSha256: streamed.sha256,
        sourceSha256: streamed.sourceSha256,
      }),
      expected,
    );

    process.env.CUSTOM_BUILD_STORAGE_BUCKET = "__local_fs__";
    process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = ".custom-build-storage/unit-stream-upload";
    const streamedPath = getCustomBuildArtifactPath({
      publicId: id,
      kind: "build_json",
      sha256: streamed.sha256,
    });
    await uploadCustomBuildArtifactFile({
      bucket: "__local_fs__",
      path: streamedPath,
      filePath: streamed.filePath,
      byteSize: streamed.storedByteSize,
      contentType: "application/json",
      encoding: "gzip",
    });
    assert.deepEqual(
      await downloadCustomBuildArtifactBytes({ bucket: "__local_fs__", path: streamedPath }),
      stored,
    );
    await deleteCustomBuildArtifact({ bucket: "__local_fs__", path: streamedPath });
  } finally {
    await streamed.cleanup();
    if (originalBucket === undefined) delete process.env.CUSTOM_BUILD_STORAGE_BUCKET;
    else process.env.CUSTOM_BUILD_STORAGE_BUCKET = originalBucket;
    if (originalStorageDir === undefined) delete process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR;
    else process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = originalStorageDir;
  }

  const secondStream = await writeCanonicalBuildArtifact(canonicalBuild);
  try {
    assert.equal(secondStream.sha256, streamed.sha256, "streamed gzip output should be deterministic");
  } finally {
    await secondStream.cleanup();
  }

  process.env.CUSTOM_BUILD_STORAGE_BUCKET = "__local_fs__";
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = ".custom-build-storage/unit-artifact-compensation";
  const compensationBytes = new TextEncoder().encode("orphan candidate");
  const compensationSha = sha256Hex(compensationBytes);
  const compensationPath = getCustomBuildArtifactPath({
    publicId: id,
    kind: "preview_svg",
    sha256: compensationSha,
  });
  try {
    await assert.rejects(
      uploadAndRecordCustomBuildArtifact({
        customBuildId: "build-without-ownership",
        publicId: id,
        kind: "preview_svg",
        bytes: compensationBytes,
        client: {
          customBuildArtifact: {
            findUnique: async () => null,
            upsert: async () => { throw new Error("database unavailable"); },
          },
        } as never,
      }),
      /database unavailable/,
    );
    await assert.rejects(
      downloadCustomBuildArtifactBytes({ bucket: "__local_fs__", path: compensationPath }),
      /ENOENT/,
      "a failed ownership write should compensate the exact uploaded object",
    );
  } finally {
    await deleteCustomBuildArtifact({ bucket: "__local_fs__", path: compensationPath });
    if (originalBucket === undefined) delete process.env.CUSTOM_BUILD_STORAGE_BUCKET;
    else process.env.CUSTOM_BUILD_STORAGE_BUCKET = originalBucket;
    if (originalStorageDir === undefined) delete process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR;
    else process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = originalStorageDir;
  }

  process.env.CUSTOM_BUILD_STORAGE_BUCKET = "__local_fs__";
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = ".custom-build-storage/unit-artifact-late-write";
  const latePath = getCustomBuildArtifactPath({ publicId: id, kind: "raw_text_debug", sha256: compensationSha });
  const updates: Array<Record<string, unknown>> = [];
  let alreadyOwned = false;
  try {
    const lateWrite = () => uploadAndRecordCustomBuildArtifact({
      customBuildId: "removed-build", publicId: id, kind: "raw_text_debug", bytes: compensationBytes,
      client: {
        customBuildArtifact: {
          findUnique: async () => {
            if (!alreadyOwned) return null;
            await deleteCustomBuildArtifact({ bucket: "__local_fs__", path: latePath });
            return { bucket: "__local_fs__", path: latePath };
          },
          upsert: async ({ create }: { create: unknown }) => create,
          aggregate: async () => ({ _sum: { storedByteSize: compensationBytes.byteLength } }),
        },
        customBuild: {
          updateMany: async ({ where }: { where: { removedAt?: unknown; status?: unknown } }) => {
            assert.equal(where.removedAt, null);
            assert.deepEqual(where.status, { in: ["queued", "running"] }, "late raw responses cannot reactivate canceled builds");
            return { count: 0 };
          },
          update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return data; },
        },
      } as never,
    });
    await assert.rejects(lateWrite(), /no longer active/);
    assert.equal(updates[0]?.objectsDeletedAt, null);
    assert.ok(updates[0]?.deletionPendingAt instanceof Date, "a late raw upload must requeue physical cleanup");
    assert.equal(updates[0]?.storedByteSize, compensationBytes.byteLength);
    alreadyOwned = true;
    await assert.rejects(lateWrite(), /no longer active/);
    await assert.rejects(downloadCustomBuildArtifactBytes({ bucket: "__local_fs__", path: latePath }), /ENOENT/,
      "a repeated upload must not recreate an immutable object while its ownership is being deleted");
  } finally {
    await deleteCustomBuildArtifact({ bucket: "__local_fs__", path: latePath });
    if (originalBucket === undefined) delete process.env.CUSTOM_BUILD_STORAGE_BUCKET;
    else process.env.CUSTOM_BUILD_STORAGE_BUCKET = originalBucket;
    if (originalStorageDir === undefined) delete process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR;
    else process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = originalStorageDir;
  }

  const originalFetch = globalThis.fetch;
  const originalSupabaseUrl = process.env.SUPABASE_URL;
  const originalSupabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let observedHeaders: Headers | null = null;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    observedHeaders = new Headers(init?.headers);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await uploadCustomBuildArtifact({
      bucket: "builds",
      path: "custom-builds/v1/cb_123456789012345678901234/build/build-a.json.gz",
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "application/gzip",
    });
    for (const failure of [504, 429, new TypeError("fetch failed"), 403, new DOMException("Aborted", "AbortError")]) {
      const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
      globalThis.fetch = (async (input, init) => {
        requests.push({ input, init });
        if (requests.length > 1) return new Response("{}", { status: 200 });
        if (failure instanceof Error) throw failure;
        return new Response("storage unavailable", { status: failure });
      }) as typeof fetch;
      const bytes = new Uint8Array([1, 2, 3]);
      const upload = uploadCustomBuildArtifact({
        bucket: "builds", path: "world-part.gz", bytes, contentType: "application/gzip",
      });
      if (failure === 403 || failure instanceof DOMException) {
        await assert.rejects(upload, failure === 403 ? /403/ : /Aborted/);
        assert.equal(requests.length, 1, "permanent failures and cancellation should not retry");
      } else {
        await upload;
        assert.equal(requests.length, 2, "transient storage failures should retry the same upload");
        assert.equal(requests[1]!.input, requests[0]!.input);
        assert.equal(requests[1]!.init?.body, bytes);
        assert.equal(new Headers(requests[1]!.init?.headers).get("x-upsert"), "true");
      }
    }
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response("still unavailable", { status: 504 });
    }) as typeof fetch;
    await assert.rejects(uploadCustomBuildArtifact({
      bucket: "builds", path: "world-part.gz", bytes: new Uint8Array([1]), contentType: "application/gzip",
    }), /Custom build artifact upload failed \(504\): still unavailable/);
    assert.equal(attempts, 3, "storage retries should stop after three attempts");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSupabaseUrl === undefined) {
      delete process.env.SUPABASE_URL;
    } else {
      process.env.SUPABASE_URL = originalSupabaseUrl;
    }
    if (originalSupabaseServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseServiceRoleKey;
    }
  }
  const headers = observedHeaders as Headers | null;
  assert.ok(headers, "Supabase upload headers should be captured");
  assert.equal(headers.get("x-upsert"), "true");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
