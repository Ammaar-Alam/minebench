import assert from "node:assert/strict";
import { rasterizeGalleryPreview } from "../../../lib/gallery/preview";

async function main() {
  const png = await rasterizeGalleryPreview(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="#123456"/></svg>',
    ),
  );

  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.byteLength > 8);
  console.log("gallery preview raster checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
