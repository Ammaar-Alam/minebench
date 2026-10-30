import assert from "node:assert/strict";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { buildGalleryPreviewSvg } from "../../../lib/gallery/preview";

const build = {
  version: "1.0" as const,
  blocks: [
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "oak_planks" },
    { x: 0, y: 1, z: 0, type: "glass" },
  ],
};

const first = buildGalleryPreviewSvg(build).toString();
const second = buildGalleryPreviewSvg(build).toString();
assert.equal(first, second);
assert.equal(first, buildGalleryPreviewSvg({ version: "1.0", blocks: [], packed: packVoxelBlocks(build.blocks) }).toString());
assert.match(first, /^<svg[^>]+viewBox="0 0 640 400" width="1280" height="800"/);
assert.match(first, /aria-hidden="true"/);
assert.equal(first.includes("<script"), false);
assert.equal((first.match(/<path /g) ?? []).length, 9);

// a solid cube shows only its three front faces
const cube = buildGalleryPreviewSvg({
  version: "1.0",
  blocks: Array.from({ length: 1_000 }, (_, index) => ({
    x: index % 10,
    y: Math.floor(index / 100),
    z: Math.floor(index / 10) % 10,
    type: "stone",
  })),
}).toString();
assert.equal((cube.match(/<path /g) ?? []).length, 3 * (3 * 10 * 10 - 3 * 10 + 1));

const bounded = buildGalleryPreviewSvg({
  version: "1.0",
  blocks: Array.from({ length: 160_000 }, (_, index) => ({ x: index % 400, y: 0, z: Math.floor(index / 400), type: "stone" })),
}).toString();
assert.ok((bounded.match(/<path /g) ?? []).length <= 360_000);

// a block straight behind another on the same isometric ray is never drawn
const hidden = buildGalleryPreviewSvg({
  version: "1.0",
  blocks: [{ x: 0, y: 0, z: 0, type: "stone" }, { x: 1, y: 1, z: 1, type: "gold_block" }],
}).toString();
assert.equal((hidden.match(/<path /g) ?? []).length, 3);
assert.equal(hidden, buildGalleryPreviewSvg({ version: "1.0", blocks: [{ x: 1, y: 1, z: 1, type: "gold_block" }] }).toString());

console.log("gallery preview checks passed");
