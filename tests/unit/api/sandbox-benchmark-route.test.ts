import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const models = ["a", "b", "c", "d", "e"].map((key) => ({
  id: `id-${key}`, key, provider: "test", displayName: key, eloRating: 1500,
}));
const prompts = [{ id: "original", text: "Original" }, { id: "gallery", text: "Gallery" }];
const builds = models.map((model, index) => ({
  id: `build-${model.key}`, modelId: model.id, model,
  promptId: index < 2 ? "original" : "gallery",
  gridSize: 256, palette: "simple", mode: "precise", blockCount: 1,
  generationTimeMs: 1000, voxelByteSize: 100, voxelCompressedByteSize: 50,
  voxelSha256: null, arenaBuildHints: null,
}));
let hasSnapshot = true;
const prismaPath = require.resolve("../../../lib/prisma");
require.cache[prismaPath] = {
  id: prismaPath, filename: prismaPath, loaded: true,
  exports: {
    prisma: {
      build: {
        groupBy: async ({ where }: { where: { active: boolean } }) => {
          assert.equal(where.active, true);
          return builds;
        },
        findMany: async ({ where }: { where: { active: boolean; promptId: string; model: { key: { in: string[] } } } }) => {
          assert.equal(where.active, true);
          return builds.filter((build) => build.promptId === where.promptId && where.model.key.in.includes(build.model.key));
        },
      },
      prompt: { findMany: async () => prompts },
      model: {
        findMany: async ({ where }: { where: { builds: { some: { active: boolean } } } }) => {
          assert.equal(where.builds.some.active, true);
          return models;
        },
      },
      galleryCandidate: { findFirst: async () => null },
      modelRankSnapshot: {
        findFirst: async () => hasSnapshot ? { capturedAt: new Date(0) } : null,
        findMany: async () => ["a", "b", "e", "d", "c"].map((key, index) => ({ rank: index + 1, model: { key } })),
      },
    },
  },
} as NodeJS.Module;

async function main() {
  const { GET } = await import("../../../app/api/sandbox/benchmark/route");
  const get = async (query: string) => {
    const response = await GET(new Request(`http://localhost/api/sandbox/benchmark${query}`));
    assert.equal(response.status, 200);
    return response.json();
  };

  const gallery = await get("?promptId=gallery");
  assert.equal(gallery.selectedPrompt.id, "gallery");
  assert.deepEqual(gallery.selectedModels, { a: "e", b: "d", c: null, d: null });
  assert.equal(gallery.builds.a.buildId, "build-e");
  assert.equal(gallery.builds.b.buildId, "build-d");
  assert.deepEqual(gallery.models.map((model: { key: string }) => model.key), ["a", "b", "c", "d", "e"]);

  for (const query of ["", "?promptId=missing"]) {
    const fallback = await get(query);
    assert.equal(fallback.selectedPrompt.id, "original");
    assert.deepEqual(fallback.selectedModels, { a: "a", b: "b", c: null, d: null });
  }
  const explicit = await get("?promptId=gallery&modelA=a&modelB=b");
  assert.deepEqual(explicit.selectedModels, { a: "a", b: "b", c: null, d: null });
  const partial = await get("?promptId=gallery&modelC=c");
  assert.deepEqual(partial.selectedModels, { a: "c", b: "a", c: null, d: null });

  hasSnapshot = false;
  const unrated = await get("?promptId=gallery");
  assert.deepEqual(unrated.selectedModels, { a: "c", b: "d", c: null, d: null });
  console.log("sandbox benchmark route checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
