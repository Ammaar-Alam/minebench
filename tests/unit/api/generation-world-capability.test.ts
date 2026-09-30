import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let world = true;
let worldReads = 0;
function stub(path: string, exports: object) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
}
stub("../../../lib/auth/request", { getAuthenticatedUserId: async () => "owner" });
stub("../../../lib/generations/service", {
  GenerationServiceError: class extends Error {},
  getOwnedGenerationArtifact: async () => ({ kind: world ? "viewer_world" : "viewer_mbv4" }),
  getOwnedGenerationWorldPart: async () => null,
});
stub("../../../lib/custom-builds/storage", { createCustomBuildArtifactSignedUrl: async () => "https://storage.example.test/build.mbv4" });
stub("../../../lib/custom-builds/worldDelivery", {
  customBuildWorldViewerResponse: async () => {
    worldReads += 1;
    return Response.json({ voxelBuild: { world: {} } });
  },
});

async function main() {
  const { GET } = await import("../../../app/api/generations/[id]/artifacts/[kind]/route");
  const get = (query = "") => GET(new Request(`http://localhost/api/generations/saved/artifacts/viewer${query}`), {
    params: Promise.resolve({ id: "saved", kind: "viewer" }),
  });
  for (const query of ["", "?part=mesh-0", "?format=mbf1"]) {
    const response = await get(query);
    assert.equal(response.status, 406, "saved worlds require explicit client capability");
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
  console.log("Saved generation world capability checks passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
