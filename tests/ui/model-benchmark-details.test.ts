import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  detailsSource.includes("Avg. inference") && detailsSource.includes("Total cost"),
  "recorded benchmark details should show inference time and total cost",
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
  !detailsSource.includes("Run setup") &&
    !detailsSource.includes("Benchmark run") &&
    !detailsSource.includes("Run details") &&
    !detailsSource.includes("Ratings reflect the current prompt set"),
  "the details hierarchy should remain flat and concise",
);
assert.ok(
  leaderboardSource.includes('const LEADERBOARD_CACHE_KEY = "mb-leaderboard-v4"'),
  "the canonical model-name change should invalidate stale client leaderboard data",
);

console.log("model benchmark details UI checks passed");
