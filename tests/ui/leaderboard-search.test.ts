import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const leaderboardSource = readFileSync("components/leaderboard/Leaderboard.tsx", "utf8");

assert.ok(
  leaderboardSource.includes('type="search"') &&
    leaderboardSource.includes('aria-controls="leaderboard-models"'),
  "leaderboard search should use a labeled search input tied to the rankings",
);
assert.ok(
  leaderboardSource.includes("matchesLeaderboardModelQuery") &&
    leaderboardSource.includes("visibleModels.map"),
  "leaderboard rows should be filtered through the shared model-query matcher",
);
assert.ok(
  leaderboardSource.includes("{m.rank}"),
  "filtered leaderboard results should preserve canonical rank numbers",
);
assert.ok(
  leaderboardSource.includes("<ModelSearchEmptyState"),
  "leaderboard search should render a recoverable empty state",
);

console.log("leaderboard search UI checks passed");
