import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeaderboardEfficiency } from "../../../components/leaderboard/LeaderboardEfficiency";
import type { LeaderboardResponse } from "../../../lib/arena/types";
import {
  formatEfficiencyResource,
  getEfficiencyAxisDomain,
  getEfficiencyPoints,
  getEfficiencyResource,
  getParetoFrontier,
} from "../../../lib/leaderboardEfficiency";

function model(key: string, cost: number, rating: number): LeaderboardResponse["models"][number] {
  return {
    key, displayName: key, provider: "test", stability: "Established",
    rankScore: rating, eloRating: rating, ratingDeviation: 20, confidence: 80, rank: 1,
    rankDelta24h: null, hasBaseline24h: false, movementVisible: false,
    shownCount: 10, winCount: 5, lossCount: 3, drawCount: 2, bothBadCount: 0,
    coveredPrompts: 15, activePrompts: 15, promptCoverage: 1, pairCoverageScore: null,
    qualityFloorScore: 1, meanScore: 0.5, scoreVariance: 0, scoreSpread: 0,
    consistency: 100, sampledPrompts: 15, sampledVotes: 100,
    benchmark: {
      averageCostUsd: cost, costEstimated: false, averageTimeMs: 100_000,
      averageBlocks: 10_000, blockSampleCount: 15, expectedBuildCount: 15,
    },
  };
}

const models = [
  model("expensive", 8, 1600), model("cheap", 1, 1400),
  model("dominated", 4, 1400), model("balanced", 2, 1500),
  model("same-cost-worse", 2, 1450), model("tied", 2, 1500),
];
const points = getEfficiencyPoints(models, "cost");
assert.deepEqual(getParetoFrontier(points).map((point) => point.model.key), ["cheap", "balanced", "tied", "expensive"]);
assert.deepEqual(models.map((entry) => entry.key), ["expensive", "cheap", "dominated", "balanced", "same-cost-worse", "tied"]);
assert.deepEqual(
  getParetoFrontier(getEfficiencyPoints(models.map((entry) => ({ ...entry, rankScore: entry.rankScore - 1500 })), "cost")).map((point) => point.model.key),
  getParetoFrontier(points).map((point) => point.model.key),
  "frontiers must not depend on the arbitrary rating origin",
);
assert.equal(points.find((point) => point.model.key === "balanced")?.perScore, 2 / 50);
assert.equal(getEfficiencyPoints([model("timing", 2, 1500)], "speed")[0].perScore, 100 / 50);
assert.equal(getEfficiencyPoints([model("blocks", 2, 1500)], "blocks")[0].perScore, 10_000 / 50);
assert.equal(getEfficiencyPoints([{ ...models[0], meanScore: 0 }], "cost")[0].perScore, null);
assert.equal(getEfficiencyPoints([{ ...models[0], meanScore: null }], "cost")[0].perScore, null);
assert.equal(getEfficiencyPoints([model("free", 0, 1400)], "cost")[0].perScore, 0);
assert.deepEqual(getParetoFrontier([]), []);
assert.equal(getParetoFrontier(points.slice(0, 1)).length, 1);
assert.deepEqual(getEfficiencyPoints([
  { ...models[0], benchmark: undefined },
  { ...models[0], sampledVotes: 0 },
  { ...models[0], sampledPrompts: 0 },
  { ...models[0], rankScore: NaN },
  model("invalid-cost", -1, 1500), model("infinite-cost", Infinity, 1500),
], "cost"), []);
const provisional = { ...models[0], stability: "Provisional" as const };
assert.equal(getEfficiencyPoints([provisional], "cost").length, 1);
assert.equal(getEfficiencyPoints([provisional], "cost", true).length, 0);
assert.equal(getEfficiencyResource({ ...models[0], benchmark: { ...models[0].benchmark!, averageTimeMs: 0 } }, "speed"), null);
assert.equal(formatEfficiencyResource(0.004, "cost"), "$0.004");
assert.equal(formatEfficiencyResource(120, "speed"), "2m");
assert.equal(formatEfficiencyResource(10_000, "blocks"), "10K");
const [logMin, logMax] = getEfficiencyAxisDomain([0.001, 0.01], true);
assert.ok(logMin < -3 && logMax > -2, "sub-dollar log scales must retain negative exponents");
const [linearMin, linearMax] = getEfficiencyAxisDomain([0.001, 0.01]);
assert.ok(linearMin <= 0.001 && linearMax > 0.01 && linearMax - linearMin < 1);
assert.deepEqual(getEfficiencyAxisDomain([]), [0, 1]);
const [singleMin, singleMax] = getEfficiencyAxisDomain([0.5], true);
assert.ok(singleMin < Math.log10(0.5) && singleMax > Math.log10(0.5));

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const render = (entries = models, query = "") => renderToStaticMarkup(React.createElement(LeaderboardEfficiency, { models: entries, modelQuery: query }));
const markup = render();
assert.ok(markup.includes("Cost per score point") && markup.includes("How to read these metrics"));
assert.ok(markup.includes("6 models · 4 on frontier"));
const searched = render(models, "dominated");
assert.ok(searched.includes("6 models · 4 on frontier"), "search must preserve the full frontier population");
assert.ok(!/NaN|Infinity/.test(render([model("fractional", 0.001, 1400), model("small", 0.01, 1500)])));
assert.ok(!/NaN|Infinity/.test(render([model("free", 0, 1400)])));
assert.ok(render([]).includes("recorded measurements and prompt votes"));
console.log("leaderboard efficiency checks passed");
