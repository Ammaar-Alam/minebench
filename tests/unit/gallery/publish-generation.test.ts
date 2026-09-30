import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mock = (path: string, exports: unknown) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeJS.Module;
};

let firstJobPayload: unknown = null;
const published: string[] = [];
mock("../../../lib/prisma", {
  prisma: {
    customBuild: {
      findUnique: async () => ({
        status: "succeeded",
        ownerId: "owner",
        publicId: "cb_build",
        jobs: firstJobPayload ? [{ payload: firstJobPayload }] : [],
      }),
    },
  },
});
mock("../../../lib/gallery/service", {
  GalleryServiceError: Error,
  requireMineBenchAdmin: async () => {},
  addGalleryExample: async (_owner: string, candidate: string, input: { generationId: string }) => {
    published.push(`${candidate}:${input.generationId}`);
  },
});

const { publishMineBenchGeneration } = require("../../../lib/gallery/communityGeneration") as typeof import("../../../lib/gallery/communityGeneration");

async function main() {
  // a retried job carries no target, but the original job does
  firstJobPayload = { serverKeys: true, galleryCandidateId: "gal_prompt" };
  await publishMineBenchGeneration({ customBuildId: "build" });
  assert.deepEqual(published, ["gal_prompt:cb_build"]);

  // user runs never publish
  published.length = 0;
  firstJobPayload = { freshGeneration: true };
  await publishMineBenchGeneration({ customBuildId: "build" });
  assert.deepEqual(published, []);

  console.log("publish generation tests passed");
}

void main();
