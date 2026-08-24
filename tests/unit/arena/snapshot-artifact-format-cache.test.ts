import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

const originalFetch = globalThis.fetch;
const originalEnv = {
  supabaseUrl: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  snapshotBucket: process.env.ARENA_SNAPSHOT_ARTIFACT_BUCKET,
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function main() {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.ARENA_SNAPSHOT_ARTIFACT_BUCKET = "builds";

  const { fetchArenaBuildSnapshotArtifact } = await import(
    "../../../lib/arena/buildSnapshotArtifacts"
  );

  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith(".mbf1")) {
      return new Response(new Uint8Array(gzipSync(Buffer.from("MBF1payload"))), { status: 200 });
    }
    if (url.endsWith(".mbv4")) {
      return new Response("missing", { status: 404 });
    }
    if (url.endsWith(".json")) {
      return new Response(new Uint8Array(gzipSync(Buffer.from('{"ok":true}'))), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  const buildId = "format-cache-build";
  const checksum = "a".repeat(64);
  const binaryMetrics = { cacheStatus: "miss" as const };
  const binary = await fetchArenaBuildSnapshotArtifact(buildId, "full", checksum, {
    format: "binary",
    metrics: binaryMetrics,
  });
  assert.equal(binary, null);
  assert.equal(binaryMetrics.cacheStatus, "miss");

  const jsonMetrics = { cacheStatus: "miss" as const, transferBytes: 0, decodedBytes: 0, inflateMs: 0 };
  const json = await fetchArenaBuildSnapshotArtifact(buildId, "full", checksum, {
    format: "json",
    metrics: jsonMetrics,
  });
  assert.ok(json);
  assert.equal(new TextDecoder().decode(json), '{"ok":true}');
  assert.equal(jsonMetrics.cacheStatus, "miss");
  assert.ok(jsonMetrics.transferBytes > jsonMetrics.decodedBytes);
  assert.equal(jsonMetrics.decodedBytes, json.byteLength);
  assert.ok(jsonMetrics.inflateMs >= 0);
  assert.equal(requests.length, 2, "a binary miss must not suppress the JSON request");

  const cachedMetrics = { cacheStatus: "miss" as const, decodedBytes: 0 };
  const cachedJson = await fetchArenaBuildSnapshotArtifact(buildId, "full", checksum, {
    format: "json",
    metrics: cachedMetrics,
  });
  assert.ok(cachedJson);
  assert.equal(cachedMetrics.cacheStatus, "body-cache");
  assert.equal(cachedMetrics.decodedBytes, cachedJson.byteLength);
  assert.equal(requests.length, 2, "a body cache hit must not fetch storage again");

  const compressedMetrics: {
    cacheStatus: "miss";
    contentEncoding?: "gzip" | "identity";
    inflateMs?: number;
  } = { cacheStatus: "miss" };
  const compressedMeshFacts = await fetchArenaBuildSnapshotArtifact(
    buildId,
    "full",
    checksum,
    {
      format: "mesh-facts",
      preserveCompression: true,
      metrics: compressedMetrics,
    },
  );
  assert.ok(compressedMeshFacts);
  assert.equal(compressedMeshFacts[0], 0x1f);
  assert.equal(compressedMetrics.contentEncoding, "gzip");
  assert.equal(compressedMetrics.inflateMs, undefined);

  const decodedMeshFacts = await fetchArenaBuildSnapshotArtifact(buildId, "full", checksum, {
    format: "mesh-facts",
  });
  assert.ok(decodedMeshFacts);
  assert.equal(new TextDecoder().decode(decodedMeshFacts), "MBF1payload");
  assert.equal(requests.length, 4, "compressed and decoded artifact bodies need separate caches");

  const privateBuildId = "private-format-cache-build";
  await fetchArenaBuildSnapshotArtifact(privateBuildId, "full", checksum, {
    format: "json",
    cache: "no-store",
  });
  await fetchArenaBuildSnapshotArtifact(privateBuildId, "full", checksum, {
    format: "json",
    cache: "no-store",
  });
  assert.equal(requests.length, 6, "private artifact bodies must never enter the process cache");

  console.log("snapshot artifact format cache checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("SUPABASE_URL", originalEnv.supabaseUrl);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", originalEnv.serviceRoleKey);
    restoreEnv("ARENA_SNAPSHOT_ARTIFACT_BUCKET", originalEnv.snapshotBucket);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
