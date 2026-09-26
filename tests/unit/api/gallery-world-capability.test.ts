import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let world = true;
let removed = false;
let worldReads = 0;
function stub(path: string, exports: object) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
}
stub("../../../lib/gallery/service", {
  GalleryServiceError: class extends Error {},
  getPublicGalleryExampleArtifact: async () => removed ? null : { kind: world ? "viewer_world" : "viewer_mbv4" },
});
stub("../../../lib/gallery/api", { apiServiceError: () => new Response(null, { status: 404 }) });
stub("../../../lib/custom-builds/storage", { createCustomBuildArtifactSignedUrl: async () => "https://storage.example.test/build.mbv4" });
stub("../../../lib/custom-builds/worldDelivery", {
  customBuildWorldViewerResponse: async () => {
    worldReads += 1;
    return Response.json({ voxelBuild: { world: {} } });
  },
});

async function main() {
  const { GET } = await import("../../../app/api/gallery/examples/[id]/[kind]/route");
  const get = (query = "") => GET(new Request(`http://localhost/api/gallery/examples/build/viewer${query}`, {
    headers: { Accept: "application/json, application/octet-stream", "User-Agent": "MineBench-iOS/1" },
  }), { params: Promise.resolve({ id: "build", kind: "viewer" }) });
  for (const query of ["", "?part=mesh-0", "?format=mbf1"]) {
    const response = await get(query);
    assert.equal(response.status, 406, "world delivery requires explicit client capability");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(worldReads, 0);
  assert.equal((await get("?format=world")).status, 200);
  assert.equal((await get("?format=world&part=mesh-0")).status, 200);
  world = false;
  for (const query of ["", "?format=world"]) {
    const response = await get(query);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://storage.example.test/build.mbv4");
  }
  assert.equal((await get("?format=world&part=mesh-0")).status, 404);
  removed = true;
  assert.equal((await get("?format=world")).status, 404);
  console.log("Gallery world capability checks passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
