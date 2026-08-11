import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pageSource = readFileSync("app/faq/page.tsx", "utf8");
const navigationSource = readFileSync("components/faq/FaqNavigation.tsx", "utf8");
const permalinkSource = readFileSync("components/faq/FaqPermalink.tsx", "utf8");

assert.ok(
  pageSource.includes(">\n            Common Questions\n          </h1>") &&
    !pageSource.includes("Questions, answered") &&
    !pageSource.includes("How the benchmark works, what models receive"),
  "the FAQ heading should stay direct and free of redundant hero copy",
);
assert.ok(
  navigationSource.includes('aria-label="FAQ sections"') &&
    navigationSource.includes("grid grid-cols-3 border-b border-border/70 lg:hidden") &&
    navigationSource.includes('className="sticky top-20 hidden self-start lg:block"') &&
    !navigationSource.includes("On this page"),
  "mobile should use a direct section rail while desktop keeps the sticky index",
);
assert.ok(
  navigationSource.includes("requestAnimationFrame") &&
    navigationSource.includes('aria-current={active ? "location" : undefined}') &&
    navigationSource.includes("marker.style.transform") &&
    navigationSource.includes("prefers-reduced-motion") &&
    !navigationSource.includes("trackOffset") &&
    !navigationSource.includes("transition-transform"),
  "the desktop FAQ index should move only its scroll-linked marker",
);
assert.ok(
  permalinkSource.includes("h-11 w-11") &&
    pageSource.includes("min-h-11 w-full") &&
    navigationSource.includes("min-h-12"),
  "mobile FAQ controls should retain at least 44px touch targets",
);
assert.ok(
  permalinkSource.includes("group-hover:[text-shadow:") &&
    permalinkSource.includes("group-focus-visible:[text-shadow:") &&
    permalinkSource.includes("motion-reduce:transform-none") &&
    !permalinkSource.includes("hover:bg-accent/10"),
  "question permalinks should glow at the glyph without a generic circular surface",
);
assert.ok(
  permalinkSource.includes("navigator.clipboard") &&
    permalinkSource.includes(".writeText(url.toString())") &&
    permalinkSource.includes("url.hash = id") &&
    permalinkSource.includes('aria-live="polite"') &&
    permalinkSource.includes('title={copied ? "Copied" : "Copy link"}'),
  "question permalinks should copy their full anchored URL and announce success",
);
assert.ok(
  pageSource.includes("break-words text-base leading-7") &&
    pageSource.includes("min-w-0 max-w-3xl break-words"),
  "long FAQ content should wrap without shrinking below readable mobile type",
);

console.log("FAQ page UI checks passed");
