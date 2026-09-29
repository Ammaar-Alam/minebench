import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let userId: string | null = "admin";
let removed = false;
let world = true;
let reads = 0;
const sourceBuildSha256 = "b".repeat(64);

class GenerationServiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function stub(path: string, exports: object) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
}

stub("../../../lib/auth/request", { getAuthenticatedUserId: async () => userId });
stub("../../../lib/generations/service", {
  GenerationServiceError,
  getAdminGenerationArtifact: async (adminId: string, id: string, kinds: string[], part?: object) => {
    reads += 1;
    assert.equal(id, "imported-world");
    if (adminId !== "admin") throw new GenerationServiceError("forbidden", "Admin access required");
    if (removed) return null;
    if (part) {
      assert.deepEqual(kinds, ["world_part"]);
      assert.deepEqual(part, { sourceBuildSha256, partKey: "region-0" });
    } else {
      assert.deepEqual(kinds, ["viewer_world", "viewer_mbf1", "viewer_mbv4"]);
    }
    return { kind: world ? "viewer_world" : "viewer_mbf1", sourceBuildSha256 };
  },
});
stub("../../../lib/custom-builds/worldDelivery", {
  customBuildWorldViewerResponse: async (args: {
    request: Request; buildId: string; cacheControl: string;
    findPart: (source: string, key: string) => Promise<unknown>;
  }) => {
    assert.equal(args.buildId, "imported-world");
    const part = new URL(args.request.url).searchParams.get("part");
    if (part) assert.ok(await args.findPart(sourceBuildSha256, part));
    return Response.json({ part }, { headers: { "Cache-Control": args.cacheControl } });
  },
});

async function main() {
  const { GET } = await import("../../../app/api/admin/generations/[id]/route");
  const get = (part = false) => GET(new Request(`http://localhost/api/admin/generations/imported-world?artifact=viewer${part ? "&part=region-0" : ""}`), {
    params: Promise.resolve({ id: "imported-world" }),
  });
  userId = null;
  assert.equal((await get()).status, 401);
  assert.equal(reads, 0);
  userId = "ordinary-user";
  assert.equal((await get()).status, 403);
  assert.equal((await get(true)).status, 403);
  userId = "admin";
  for (const part of [false, true]) {
    const response = await get(part);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { part: part ? "region-0" : null });
  }
  world = false;
  assert.equal((await get(true)).status, 404);
  removed = true;
  assert.equal((await get()).status, 404);
  assert.equal((await get(true)).status, 404);
  console.log("Admin world inspection and part authorization checks passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
