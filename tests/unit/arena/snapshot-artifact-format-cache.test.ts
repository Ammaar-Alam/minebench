import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalEnv = {
  supabaseUrl: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  snapshotBucket: process.env.ARENA_SNAPSHOT_ARTIFACT_BUCKET,
  binaryEnabled: process.env.ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED,
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function main() {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.ARENA_SNAPSHOT_ARTIFACT_BUCKET = "builds";
  process.env.ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED = "1";

  const { fetchArenaBuildSnapshotArtifact } = await import(
    "../../../lib/arena/buildSnapshotArtifacts"
  );

  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith(".mbv4")) {
      return new Response("missing", { status: 404 });
    }
    if (url.endsWith(".json")) {
      return new Response('{"ok":true}', { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  const buildId = "format-cache-build";
  const checksum = "a".repeat(64);
  const binary = await fetchArenaBuildSnapshotArtifact(buildId, "full", checksum, {
    format: "binary",
  });
  assert.equal(binary, null);

  const json = await fetchArenaBuildSnapshotArtifact(buildId, "full", checksum, {
    format: "json",
  });
  assert.ok(json);
  assert.equal(new TextDecoder().decode(json), '{"ok":true}');
  assert.equal(requests.length, 2, "a binary miss must not suppress the JSON request");

  const privateBuildId = "private-format-cache-build";
  await fetchArenaBuildSnapshotArtifact(privateBuildId, "full", checksum, {
    format: "json",
    cache: "no-store",
  });
  await fetchArenaBuildSnapshotArtifact(privateBuildId, "full", checksum, {
    format: "json",
    cache: "no-store",
  });
  assert.equal(requests.length, 4, "private artifact bodies must never enter the process cache");

  console.log("snapshot artifact format cache checks passed");
}

main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("SUPABASE_URL", originalEnv.supabaseUrl);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", originalEnv.serviceRoleKey);
    restoreEnv("ARENA_SNAPSHOT_ARTIFACT_BUCKET", originalEnv.snapshotBucket);
    restoreEnv(
      "ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED",
      originalEnv.binaryEnabled,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
