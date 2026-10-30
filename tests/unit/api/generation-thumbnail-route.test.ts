import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
let ownerId: string | null = "owner";
let artifactReads = 0;
let downloads = 0;
let signedUrl = "file:///thumbnail.png";
let requestedKinds: string[] = [];

class GenerationServiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function stub(path: string, exports: object) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
}

stub("../../../lib/auth/request", { getAuthenticatedUserId: async () => ownerId });
stub("../../../lib/generations/service", {
  GenerationServiceError,
  getOwnedGenerationArtifact: async (owner: string, id: string, kinds: string[]) => {
    artifactReads += 1;
    requestedKinds = kinds;
    assert.equal(id, "saved-build");
    return owner === "owner" ? { contentType: "image/png", encoding: null } : null;
  },
});
stub("../../../lib/custom-builds/storage", {
  createCustomBuildArtifactSignedUrl: async () => signedUrl,
  downloadCustomBuildArtifactBytes: async () => { downloads += 1; return png; },
});

async function main() {
  const { GET } = await import("../../../app/api/generations/[id]/artifacts/[kind]/route");
  const get = (kind = "thumbnail", query = "?format=png") => GET(
    new Request(`http://localhost/api/generations/saved-build/artifacts/${kind}${query}`),
    { params: Promise.resolve({ id: "saved-build", kind }) },
  );

  ownerId = null;
  assert.equal((await get()).status, 401);
  assert.equal(artifactReads, 0);
  assert.equal(downloads, 0);

  ownerId = "another-owner";
  assert.equal((await get()).status, 404);
  assert.equal(downloads, 0);

  ownerId = "owner";
  const native = await get();
  assert.equal(native.status, 200);
  assert.equal(native.headers.get("content-type"), "image/png");
  assert.equal(native.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(requestedKinds, ["preview_image"]);
  assert.deepEqual(new Uint8Array(await native.arrayBuffer()), new Uint8Array(png));

  const original = await get("thumbnail", "");
  assert.equal(original.headers.get("content-type"), "image/png");
  assert.equal(original.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), new Uint8Array(png));

  signedUrl = "https://storage.example.test/owned-artifact";
  const beforeRedirects = downloads;
  for (const [kind, kinds] of [
    ["thumbnail", ["preview_image"]],
    ["preview", ["preview_mbv4"]],
    ["viewer", ["viewer_world", "viewer_mbf1", "viewer_mbv4"]],
  ] as const) {
    const response = await get(kind, kind === "thumbnail" ? "" : "?format=png");
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), signedUrl);
    assert.deepEqual(requestedKinds, kinds);
  }
  assert.equal(downloads, beforeRedirects);
  console.log("saved generation thumbnail route checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
