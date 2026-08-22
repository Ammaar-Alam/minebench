import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  decodeStoredBuildText,
  fetchStoredBuildBytes,
} from "../../../lib/storage/buildPayload";

async function main() {
  const compressed = gzipSync(Buffer.from("x".repeat(8_192)));
  assert.throws(
    () => decodeStoredBuildText(compressed, null, { maxOutputBytes: 1_024 }),
    /size limit/,
  );

  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://storage.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "storage-test-key";
  try {
    global.fetch = (async () =>
      new Response(new Uint8Array(16), { headers: { "Content-Length": "16" } })) as typeof fetch;
    await assert.rejects(
      fetchStoredBuildBytes({ bucket: "builds", path: "large.json" }, { maxBytes: 8 }),
      /size limit/,
    );

    global.fetch = (async () => new Response(new Uint8Array(16))) as typeof fetch;
    await assert.rejects(
      fetchStoredBuildBytes({ bucket: "builds", path: "streamed.json" }, { maxBytes: 8 }),
      /size limit/,
    );
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
