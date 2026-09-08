import assert from "node:assert/strict";
import { fitGalleryPromptHeading } from "../../../components/gallery/GalleryDetail";

const originalDocument = globalThis.document;
const originalGetComputedStyle = globalThis.getComputedStyle;
Object.assign(globalThis, {
  document: { documentElement: { style: { fontSize: "16px" } } },
  getComputedStyle: (element: HTMLElement) => element.style,
});

try {
  let heightPerRem = 20;
  const container = { clientHeight: 128, style: { fontSize: "48px" } };
  const style = { fontSize: "" };
  const heading = {
    parentElement: container,
    isConnected: true,
    style,
    get scrollHeight() { return parseFloat(style.fontSize) * heightPerRem; },
  } as unknown as HTMLHeadingElement;

  assert.equal(fitGalleryPromptHeading(heading), false);
  assert.equal(heading.style.fontSize, "3rem", "short prompts keep the largest type");

  heightPerRem = 80;
  assert.equal(fitGalleryPromptHeading(heading), false);
  assert.equal(heading.style.fontSize, "1.5rem", "medium prompts use the largest size that fits");

  heightPerRem = 200;
  assert.equal(fitGalleryPromptHeading(heading), true);
  assert.equal(heading.style.fontSize, "1.125rem", "overflow stops shrinking at the readable minimum");

  heightPerRem = 20;
  container.style.fontSize = "30px";
  assert.equal(fitGalleryPromptHeading(heading), false);
  assert.equal(heading.style.fontSize, "1.875rem", "refitting respects the current responsive maximum");

  container.clientHeight = 0;
  assert.equal(fitGalleryPromptHeading(heading), null, "hidden routes retain their last fit");
  assert.equal(heading.style.fontSize, "1.875rem");
} finally {
  Object.assign(globalThis, { document: originalDocument, getComputedStyle: originalGetComputedStyle });
}

console.log("Gallery prompt fitting checks passed");
