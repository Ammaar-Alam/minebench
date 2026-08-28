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
const sandboxPage = readFileSync("app/sandbox/page.tsx", "utf8");
const galleryDetailPage = readFileSync("app/gallery/[publicId]/page.tsx", "utf8");
const siteHeader = readFileSync("components/SiteHeader.tsx", "utf8");
const galleryClient = readFileSync("lib/gallery/client.ts", "utf8");
const galleryButton = readFileSync("components/gallery/GenerationGalleryButton.tsx", "utf8");
const sandboxLive = readFileSync("components/sandbox/SandboxLive.tsx", "utf8");
const adminActions = readFileSync("app/admin/gallery/actions.ts", "utf8");
const adminDashboard = readFileSync("components/gallery/GalleryAdminDashboard.tsx", "utf8");
const galleryService = readFileSync("lib/gallery/service.ts", "utf8");

assert.ok(
  detail.includes("candidate.canRemove") &&
    detail.includes('method: "DELETE"') &&
    detail.includes('router.push("/gallery")'),
  "ordinary candidate owners should have a reachable Remove action",
);
assert.ok(
  detail.includes("SandboxGifExportButton") &&
    detail.includes("MAX_COMPARISON_EXAMPLES = 4") &&
    detail.includes("event.metaKey || event.ctrlKey") &&
    detail.includes("compareMode && selectedIds.length === 1 && selectedIds[0] === exampleId") &&
    detail.includes('compareMode ? "Single" : "Compare"') &&
    detail.includes("comparisonTargets") &&
    detail.includes("selectedIds.slice(0, 1)") &&
    detail.includes("viewerRef={getViewerRef(example.id)}") &&
    detail.includes('label="GIF"') &&
    detail.includes("embedded") &&
    !detail.includes("iconOnly"),
  "public examples should support accessible four-build comparison through the shared GIF exporter",
);
assert.ok(
  galleryClient.includes("body.created === false") &&
    galleryClient.includes("/examples`") &&
    yours.includes("Add to Gallery") &&
    !yours.includes("Add this generation as an example?") &&
    yours.includes("downloadSavedGenerationJson") &&
    yours.includes("SavedBuildDialog") &&
    yours.includes("generation.expandedBytes") &&
    yours.includes("jsonBytes={generation.expandedBytes}") &&
    yours.includes("generation.generationTimeMs") &&
    yours.includes("SHA-256 ") &&
    yours.includes("hover:after:scale-x-100") &&
    yours.includes('generation.status === "queued" || generation.status === "running"') &&
    yours.includes("<VoxelEmptyState") &&
    yours.includes('generation.error?.retryable') &&
    yours.includes('/retry`') &&
    yours.includes("embedded"),
  "saved builds should open privately, reuse lifecycle placeholders, support retry, and expose owner verification details",
);
assert.ok(
  yours.includes("publishGenerationToGallery") &&
    sandboxLive.includes("<GenerationGalleryButton") &&
    sandboxLive.includes("singleGalleryResult") &&
    sandboxLive.includes('r?.status === "success"') &&
    sandboxLive.includes("retryCustomBuild") &&
    galleryButton.includes("Add to Gallery") &&
    galleryButton.includes("canChooseAttribution") &&
    galleryButton.includes("checked={anonymous}"),
  "successful Generate results should reuse the Gallery submission path beside Generate",
);
assert.ok(
  adminActions.includes('type: z.literal("example_hidden")') &&
    adminActions.includes("hideGalleryExample") &&
    adminDashboard.includes("Hide build"),
  "reported Gallery examples should expose the exact-build moderation action",
);
assert.ok(
  adminActions.includes('type: z.literal("hosted_generation_limit")') &&
    adminActions.includes("setHostedGenerationLimit") &&
    adminDashboard.includes("Total generations") &&
    adminDashboard.includes("Hosted generations") &&
    adminDashboard.includes('name="limit"'),
  "Gallery admin should show lifetime and hosted generation counts with an editable hosted limit",
);
assert.ok(
  galleryService.includes('action: { label: "Appeal", href: galleryUrl("/account") }'),
  "suspension email should link directly to the account appeal surface",
);
assert.ok(
  yours.includes('fetch("/api/generations", { cache: "no-store", signal: controller.signal })') &&
    yours.includes("setItems(page.items)") &&
    yours.includes("setCursor(page.nextCursor)"),
  "saved builds should refresh their first page on mount instead of trusting stale route props",
);
assert.equal(
  yours.includes("generation.storedBytes"),
  false,
  "saved builds should not expose internal compressed-storage accounting",
);
assert.ok(
  [page, galleryDetailPage, sandboxPage].every((source) => source.includes("getCurrentAccount().catch(() => null)")),
  "public pages should treat account lookup as optional when Auth is not configured",
);
assert.ok(
  siteHeader.includes("[active, pathname]"),
  "the persistent header should recheck Auth state after every route change",
);
assert.ok(
  explore.includes("VoxelEmptyState") &&
    explore.includes("candidate.cover?.previewUrl") &&
    explore.includes("candidate.alternate?.previewUrl") &&
    explore.includes("modelLabels.join") &&
    explore.includes("candidate.cover?.jsonBytes") &&
    explore.includes("candidate.cover?.generationTimeMs") &&
    explore.includes("candidate.exampleCount - 2") &&
    !explore.includes("featured"),
  "Gallery cards should keep a clear media frame and reveal additional model builds without extra requests",
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
