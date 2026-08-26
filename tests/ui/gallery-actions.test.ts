import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const detail = readFileSync("components/gallery/GalleryDetail.tsx", "utf8");
const explore = readFileSync("components/gallery/GalleryExplore.tsx", "utf8");
const yours = readFileSync("components/gallery/GalleryYours.tsx", "utf8");
const page = readFileSync("app/gallery/page.tsx", "utf8");
const account = readFileSync("app/account/page.tsx", "utf8");
const identity = readFileSync("app/account/GalleryAccountSettings.tsx", "utf8");
const yoursPage = readFileSync("app/gallery/yours/page.tsx", "utf8");
const preflight = readFileSync("components/sandbox/GenerationPreflightDialog.tsx", "utf8");

assert.ok(
  detail.includes("candidate.canRemove") &&
    detail.includes('method: "DELETE"') &&
    detail.includes('router.push("/gallery")'),
  "ordinary candidate owners should have a reachable Remove action",
);
assert.ok(
  detail.includes("SandboxGifExportButton") &&
    detail.includes("viewerRef={viewerRef}") &&
    detail.includes('label="GIF"') &&
    detail.includes("embedded") &&
    !detail.includes("iconOnly"),
  "public examples should reuse the full viewer GIF exporter",
);
assert.ok(
  yours.includes("body.created === false") &&
    yours.includes("/examples`") &&
    yours.includes("Add to Gallery") &&
    !yours.includes("Add this generation as an example?") &&
    yours.includes("downloadSavedGenerationJson") &&
    yours.includes("SavedBuildDialog") &&
    yours.includes("generation.expandedBytes") &&
    !yours.includes("generation.storedBytes") &&
    yours.includes("headerMeta=") &&
    !yours.includes("SHA-256 ") &&
    yours.includes("hover:after:scale-x-100") &&
    yours.includes("embedded"),
  "saved builds should open privately and expose their expanded JSON download and size",
);
assert.ok(
  explore.includes("VoxelEmptyState") &&
    explore.includes("candidate.cover?.previewUrl") &&
    !explore.includes("featured"),
  "every Gallery candidate should retain a clear media frame without fake build imagery",
);
assert.ok(
  !page.includes("key={sort}") &&
    explore.includes("changeSort") &&
    explore.includes("window.history.replaceState") &&
    explore.includes("key={activeSort}"),
  "Top and New should replace only the Gallery results and animate the new grid",
);
assert.ok(
  account.includes("<GalleryYours") &&
    account.includes("lg:grid-cols-[minmax(0,1fr)_18rem]") &&
    yoursPage.includes('permanentRedirect("/account#builds")') &&
    !identity.includes("border-l-2"),
  "Account should own saved builds, rankings, and its compact settings rail",
);
assert.equal(
  [detail, explore, preflight].some((source) => source.includes("shadow-2xl")),
  false,
  "public dialogs should follow the flat-surface design language",
);
assert.ok(
  [detail, explore, yours, preflight].every((source) => source.includes("mb-dialog")),
  "Gallery and generation dialogs should share the same entrance motion",
);
assert.equal(
  ["Build what comes next.", "Prompts and worlds from the community.", "The first prompt is yours.", "Use the prompt, then share your result."].some((copy) => detail.includes(copy) || explore.includes(copy)),
  false,
  "Gallery surfaces should avoid generic promotional and empty-state narration",
);

console.log("Gallery action UI checks passed");
