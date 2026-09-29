import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { deleteSupabaseStorageObjects } from "../../../lib/storage/buildPayload";
import { deleteCustomBuildArtifacts, downloadCustomBuildArtifactBytes, uploadCustomBuildArtifact } from "../../../lib/custom-builds/storage";

const previousEnv = Object.fromEntries(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "CUSTOM_BUILD_LOCAL_STORAGE_DIR"]
  .map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const directory = ".custom-build-storage/unit-deletion";

async function main() {
  process.env.SUPABASE_URL = "https://storage.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "storage-deletion-test-key";
  delete process.env.SUPABASE_SECRET_KEY;
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = directory;
  const requests: Array<{ url: string; paths: string[] }> = [];
  let closedBodies = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "DELETE");
    const { prefixes } = JSON.parse(String(init?.body)) as { prefixes: string[] };
    requests.push({ url: String(input), paths: prefixes });
    return new Response(new ReadableStream({ cancel() { closedBodies += 1; } }));
  };
  const firstBucket = Array.from({ length: 1001 }, (_, index) => ({ bucket: "builds", path: `world/part-${index}` }));
  await deleteSupabaseStorageObjects([...firstBucket, firstBucket[0]!, { bucket: "previews", path: "preview.svg" }]);
  assert.deepEqual(requests.map(({ paths }) => paths.length), [1000, 1, 1]);
  assert.deepEqual(requests.slice(0, 2).flatMap(({ paths }) => paths), firstBucket.map(({ path }) => path));
  assert.equal(requests[2]!.url, "https://storage.example.test/storage/v1/object/previews");
  assert.equal(closedBodies, 3, "every completed deletion must release its response body");

  const local = { bucket: "__local_fs__", path: "world/source.json" };
  await uploadCustomBuildArtifact({ ...local, bytes: new Uint8Array([1]), contentType: "application/json" });
  requests.length = 0;
  await deleteCustomBuildArtifacts([local, ...firstBucket]);
  assert.deepEqual(requests.map(({ paths }) => paths.length), [1000, 1]);
  await assert.rejects(downloadCustomBuildArtifactBytes(local), /ENOENT/);
  await deleteCustomBuildArtifacts([local]);
  await deleteCustomBuildArtifacts([]);
  assert.equal(requests.length, 2, "local and empty deletion batches must not call remote storage");

  let failedRequests = 0;
  globalThis.fetch = async () => {
    failedRequests += 1;
    return new Response("unavailable", { status: 503 });
  };
  await assert.rejects(deleteSupabaseStorageObjects(firstBucket), /Storage deletion failed \(503\)/);
  assert.equal(failedRequests, 1, "failed batches remain queued for a later drain");
  console.log("batched build storage deletion checks passed");
}

void main().finally(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
}).catch((error) => { console.error(error); process.exitCode = 1; });
