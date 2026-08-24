import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeaderboardSkeleton } from "../../../components/leaderboard/LeaderboardSkeleton";

const markup = renderToStaticMarkup(React.createElement(LeaderboardSkeleton));

assert.match(markup, /aria-busy="true"/);
assert.match(markup, /Loading leaderboard/);
assert.match(markup, /mb-leaderboard-skeleton-block/);
assert.match(markup, /mb-leaderboard-skeleton-shimmer/);
assert.doesNotMatch(markup, />Loading…</);

const shimmerCount = markup.match(/mb-leaderboard-skeleton-shimmer/g)?.length ?? 0;
const blockCount = markup.match(/mb-leaderboard-skeleton-block/g)?.length ?? 0;
assert.ok(shimmerCount > 0);
assert.ok(shimmerCount < blockCount / 4);

const slowMarkup = renderToStaticMarkup(
  React.createElement(LeaderboardSkeleton, { slow: true }),
);
assert.match(slowMarkup, /Taking longer than usual/);

console.log("leaderboard skeleton render checks passed");
