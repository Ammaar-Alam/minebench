import assert from "node:assert/strict";
import sharp from "sharp";
import { buildGalleryPreviewPng } from "../../../lib/gallery/preview";

async function main() {
  const png = await buildGalleryPreviewPng({ version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] });

  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  const { width, height } = await sharp(png).metadata();
  assert.deepEqual([width, height], [1280, 800]);
  console.log("gallery preview raster checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
