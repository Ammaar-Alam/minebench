import assert from "node:assert/strict";
import { buildGalleryPreviewSvg } from "../../../lib/gallery/preview";

const build = {
  version: "1.0" as const,
  blocks: [
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "oak_planks" },
    { x: 0, y: 1, z: 0, type: "glass" },
  ],
};

const first = buildGalleryPreviewSvg(build);
const second = buildGalleryPreviewSvg(build);
assert.equal(first, second);
assert.match(first, /^<svg[^>]+viewBox="0 0 640 400"/);
assert.match(first, /aria-hidden="true"/);
assert.equal(first.includes("<script"), false);
assert.equal((first.match(/<path /g) ?? []).length, 9);

const bounded = buildGalleryPreviewSvg({
  version: "1.0",
  blocks: Array.from({ length: 2_000 }, (_, index) => ({
    x: index % 50,
    y: Math.floor(index / 500),
    z: Math.floor(index / 50),
    type: "stone",
  })),
});
assert.ok((bounded.match(/<path /g) ?? []).length <= 3_600);

console.log("gallery preview checks passed");
