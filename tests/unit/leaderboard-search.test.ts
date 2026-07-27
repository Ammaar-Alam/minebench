import assert from "node:assert/strict";
import { matchesLeaderboardModelQuery } from "../../lib/leaderboardSearch";

const model = {
  displayName: "Claude Opus 5",
  provider: "anthropic",
};

assert.equal(matchesLeaderboardModelQuery(model, ""), true);
assert.equal(matchesLeaderboardModelQuery(model, "  "), true);
assert.equal(matchesLeaderboardModelQuery(model, "CLAUDE"), true);
assert.equal(matchesLeaderboardModelQuery(model, "anthropic"), true);
assert.equal(matchesLeaderboardModelQuery(model, "claude anthropic"), true);
assert.equal(matchesLeaderboardModelQuery(model, "claude openai"), false);

const rankedModels = [
  { displayName: "Claude Opus 5", provider: "anthropic", rank: 1 },
  { displayName: "GPT 5.6 Sol Pro", provider: "openai", rank: 2 },
  { displayName: "GPT 5.5 Pro", provider: "openai", rank: 3 },
];
const filteredModels = rankedModels.filter((candidate) =>
  matchesLeaderboardModelQuery(candidate, "openai"),
);

assert.deepEqual(
  filteredModels.map(({ displayName, rank }) => ({ displayName, rank })),
  [
    { displayName: "GPT 5.6 Sol Pro", rank: 2 },
    { displayName: "GPT 5.5 Pro", rank: 3 },
  ],
);

console.log("leaderboard search checks passed");
