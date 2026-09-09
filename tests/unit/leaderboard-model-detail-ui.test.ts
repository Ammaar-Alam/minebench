import assert from "node:assert/strict";

import { sortModelOpponentsForDetail } from "../../components/leaderboard/ModelDetail";
import type { ModelOpponentBreakdown } from "../../lib/arena/stats";

function opponent(
  key: string,
  averageScore: number,
  votes: number,
  bothBad = 0,
): ModelOpponentBreakdown {
  return {
    key,
    displayName: key,
    votes,
    averageScore,
    wins: 0,
    losses: 0,
    draws: 0,
    bothBad,
  };
}

const ordered = sortModelOpponentsForDetail([
  opponent("no scored votes", 0, 0, 4),
  opponent("best", 0.78, 6),
  opponent("same score less evidence", 0.5, 2),
  opponent("worst", 0.18, 3),
  opponent("same score more evidence", 0.5, 7),
  opponent("bad score value", Number.NaN, 9),
]);

assert.deepEqual(
  ordered.map((row) => row.key),
  [
    "worst",
    "same score more evidence",
    "same score less evidence",
    "best",
    "bad score value",
    "no scored votes",
  ],
);

console.log("leaderboard model detail UI checks passed");
