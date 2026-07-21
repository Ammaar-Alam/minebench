import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelBenchmarkDetailsInline } from "../../components/leaderboard/ModelBenchmarkDetails";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const detailsSource = readFileSync(
  "components/leaderboard/ModelBenchmarkDetails.tsx",
  "utf8",
);
const leaderboardSource = readFileSync("components/leaderboard/Leaderboard.tsx", "utf8");
const modelDetailSource = readFileSync("components/leaderboard/ModelDetail.tsx", "utf8");

assert.ok(
  detailsSource.includes("aria-expanded={expanded}") &&
    detailsSource.includes("aria-controls={controlsId}") &&
    detailsSource.includes('aria-label={`View ${displayName} run details`}'),
  "model details trigger should expose its disclosure state and accessible name",
);
assert.ok(
  detailsSource.includes('role="region"') &&
    !detailsSource.includes('aria-modal="true"') &&
    !detailsSource.includes("backdrop-blur") &&
    !detailsSource.includes("fixed inset-0"),
  "model run details should use a nonmodal region without a full-screen backdrop",
);
assert.ok(
  detailsSource.includes("h-6 w-6") &&
    detailsSource.includes("before:-inset-y-2.5") &&
    detailsSource.includes("before:-left-1 before:-right-4") &&
    detailsSource.includes("h-[15px] w-[15px]"),
  "the quiet info glyph should retain a 44px touch target without widening its layout box",
);
assert.ok(
  detailsSource.includes('document.addEventListener("pointerdown"') &&
    detailsSource.includes('event.key === "Escape"') &&
    detailsSource.includes("event.stopPropagation()") &&
    !detailsSource.includes("onKeyDown={(event) => event.stopPropagation()}"),
  "the desktop popover should dismiss cleanly without activating its leaderboard row",
);
assert.ok(
  detailsSource.includes('document.addEventListener("scroll", handleScroll, true)') &&
    detailsSource.includes("panelRef.current?.contains(target)") &&
    !detailsSource.includes('window.addEventListener("scroll", updatePosition, true)'),
  "leaderboard scrolling should dismiss the popover while preserving its own internal scroll",
);
assert.ok(
  detailsSource.includes('placement: "above" | "below"') &&
    detailsSource.includes("style={{ left: position.arrowLeft }}") &&
    detailsSource.includes('aria-hidden="true"'),
  "the popover should render a placement-aware pointer aligned with its trigger",
);
assert.ok(
  detailsSource.includes("const POPOVER_GAP = 4") &&
    detailsSource.includes("fixed z-30 overflow-visible") &&
    detailsSource.includes("max-h-[calc(100dvh-2rem)] overflow-y-auto") &&
    detailsSource.includes("rounded-[inherit] p-4"),
  "the anchored shell should expose its pointer while an inner viewport owns overflow",
);
assert.ok(
  detailsSource.includes("This model was benchmarked before run statistics were tracked."),
  "models without recorded statistics should still receive a useful details note",
);
assert.ok(
  detailsSource.includes(">\n          Parameters\n        </h3>") &&
    detailsSource.includes(">\n          Statistics\n        </h3>") &&
    detailsSource.includes("<DetailRows rows={profile.parameters} />") &&
    detailsSource.includes("<DetailRows rows={statistics} />"),
  "run parameters and benchmark statistics should render as distinct sections",
);
assert.ok(
  detailsSource.includes("Avg. inference") &&
    detailsSource.includes("Total cost") &&
    detailsSource.includes("statistics.length > 0"),
  "recorded benchmark details should show available statistics before using the fallback",
);
assert.ok(
  !detailsSource.includes('label: "Run size"'),
  "benchmark tables should expose only the two reported statistics",
);
assert.ok(
  leaderboardSource.includes("<ModelBenchmarkDetailsTrigger") &&
    leaderboardSource.includes("<ModelBenchmarkDetailsInline") &&
    leaderboardSource.includes("<ModelBenchmarkDetails") &&
    modelDetailSource.includes("<ModelBenchmarkDetails"),
  "mobile leaderboard cards should expand inline while desktop and model profiles expose the popover",
);
assert.ok(
  (leaderboardSource.match(/onClick=\{\(\) => navigateToModel\(m\.key\)\}/g)?.length ??
    0) === 2 &&
    leaderboardSource.includes("event.stopPropagation();") &&
    leaderboardSource.includes('aria-label={`Open ${m.displayName} profile`}'),
  "leaderboard rows and cards should navigate by pointer while preserving isolated accessible controls",
);
assert.ok(
  !detailsSource.includes("Run setup") &&
    !detailsSource.includes("Benchmark run") &&
    !detailsSource.includes("Run details") &&
    !detailsSource.includes("Ratings reflect the current prompt set"),
  "the details hierarchy should keep concise, user-facing labels",
);
assert.ok(
  leaderboardSource.includes('const LEADERBOARD_CACHE_KEY = "mb-leaderboard-v4"'),
  "the canonical model-name change should invalidate stale client leaderboard data",
);

const trackedMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "tracked-details",
    modelKey: "openai_gpt_5_6_sol",
    displayName: "GPT 5.6 Sol Pro",
    open: true,
  }),
);
assert.ok(
  trackedMarkup.includes("Parameters") &&
    trackedMarkup.includes("Statistics") &&
    trackedMarkup.includes("25m 16.2s") &&
    trackedMarkup.includes("$710.82") &&
    !trackedMarkup.includes("before run statistics were tracked"),
  "a fully tracked model should render parameters and both benchmark statistics",
);

const costOnlyMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "cost-only-details",
    modelKey: "openai_gpt_5_4",
    displayName: "GPT 5.4",
    open: true,
  }),
);
assert.ok(
  costOnlyMarkup.includes("XHigh") &&
    costOnlyMarkup.includes("Total cost") &&
    costOnlyMarkup.includes("~$25") &&
    !costOnlyMarkup.includes("before run statistics were tracked"),
  "a cost-only model should render its available statistic without the fallback",
);

const untrackedMarkup = renderToStaticMarkup(
  React.createElement(ModelBenchmarkDetailsInline, {
    id: "untracked-details",
    modelKey: "openai_gpt_4_5_web_harness",
    displayName: "GPT 4.5 (web harness)",
    open: true,
  }),
);
assert.ok(
  untrackedMarkup.includes("ChatGPT web harness") &&
    untrackedMarkup.includes("before run statistics were tracked") &&
    untrackedMarkup.includes("not directly comparable to API-generated runs"),
  "an untracked run should keep its parameters, statistics fallback, and comparability note",
);

console.log("model benchmark details UI checks passed");
