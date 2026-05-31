import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const leaderboardSource = readFileSync("components/leaderboard/Leaderboard.tsx", "utf8");
const cssSource = readFileSync("app/globals.css", "utf8");

assert.ok(
  leaderboardSource.includes('data-details={showDetailed ? "open" : "closed"}'),
  "leaderboard table should expose the detail toggle state for CSS motion",
);
assert.ok(
  leaderboardSource.includes('showDetailed ? "mb-leaderboard-rating-detail-open" : "mb-leaderboard-rating-detail-closed"'),
  "rating subtext should expand and collapse with the detailed view",
);
assert.ok(
  leaderboardSource.includes("{Math.round(m.eloRating).toLocaleString()}"),
  "detailed rating subtext should show the raw rating value",
);
assert.ok(
  cssSource.includes(".mb-leaderboard-rating-detail"),
  "rating detail typography class should be defined",
);
assert.ok(
  cssSource.includes(".mb-leaderboard-rating-detail-open"),
  "rating detail open state should be defined",
);
assert.ok(
  cssSource.includes(".mb-leaderboard-rating-detail-closed"),
  "rating detail closed state should be defined",
);
assert.ok(
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mb-leaderboard-rating-detail/.test(cssSource),
  "rating detail motion should respect reduced-motion preferences",
);

console.log("leaderboard details UI checks passed");
