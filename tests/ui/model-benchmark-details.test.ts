import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const detailsSource = readFileSync(
  "components/leaderboard/ModelBenchmarkDetails.tsx",
  "utf8",
);
const leaderboardSource = readFileSync("components/leaderboard/Leaderboard.tsx", "utf8");
const modelDetailSource = readFileSync("components/leaderboard/ModelDetail.tsx", "utf8");

assert.ok(
  detailsSource.includes('aria-haspopup="dialog"') &&
    detailsSource.includes('aria-label={`View ${displayName} run details`}'),
  "model details trigger should expose its dialog semantics and accessible name",
);
assert.ok(
  detailsSource.includes('role="dialog"') && detailsSource.includes('aria-modal="true"'),
  "model run details should render as an accessible dialog",
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
  leaderboardSource.includes("<ModelBenchmarkDetails") &&
    modelDetailSource.includes("<ModelBenchmarkDetails"),
  "the leaderboard and model profile should both expose model run details",
);
assert.ok(
  leaderboardSource.includes('const LEADERBOARD_CACHE_KEY = "mb-leaderboard-v4"'),
  "the canonical model-name change should invalidate stale client leaderboard data",
);

console.log("model benchmark details UI checks passed");
