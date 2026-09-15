import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { confidenceFromRd, RD_CEILING, RD_FLOOR } from "../../../lib/arena/rating";
import { formatPercent } from "../../../components/lab/format";
import { ResultsDashboard } from "../../../components/lab/ResultsDashboard";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value * 100));
}

(globalThis as typeof globalThis & { React: typeof React }).React = React;

assert.equal(confidenceFromRd(RD_CEILING), 0, "max RD must yield 0% confidence");
assert.equal(confidenceFromRd(RD_FLOOR), 100, "floor RD must yield 100% confidence");
assert.equal(
  confidenceFromRd(190),
  50,
  "mid RD (190) must yield 50% confidence on the report's 0-100 scale",
);

const resultsPage = readFileSync(
  "app/lab/[orgSlug]/experiments/[experimentId]/results/page.tsx",
  "utf8",
);
assert.match(
  resultsPage,
  /confidence: variant\.confidence\s*\/\s*100/,
  "results page must normalize confidence to a 0-1 fraction for the dashboard",
);

for (const [rd, expectedPercent, expectedText] of [
  [RD_CEILING, 0, "0%"],
  [190, 50, "50%"],
  [75, 86, "86%"],
  [RD_FLOOR, 100, "100%"],
] as const) {
  const reportConfidence = confidenceFromRd(rd);
  const dashboardConfidence = reportConfidence / 100;
  assert.equal(
    formatPercent(dashboardConfidence),
    expectedText,
    `confidence text for rd=${rd} should read ${expectedText}, not inflated`,
  );
  assert.equal(
    clampPercent(dashboardConfidence),
    expectedPercent,
    `confidence bar width for rd=${rd} should be ${expectedPercent}%, not pinned at 100%`,
  );
}

const reportConfidence = confidenceFromRd(190);
assert.equal(
  formatPercent(reportConfidence),
  "5000%",
  "without normalization the formatter inflates 50 to 5000% (the bug)",
);
assert.equal(
  clampPercent(reportConfidence),
  100,
  "without normalization the bar is clamped to 100% for any confidence >= 1 (the bug)",
);

const baseOutcome = {
  votes: 5,
  decisiveVotes: 5,
  wins: 3,
  losses: 1,
  draws: 1,
  bothBad: 0,
  averageScore: 0.7,
};
const baseVariant = {
  id: "v1",
  codename: "Alpha",
  rating: 1500,
  ratingDeviation: 190,
  stability: "Established" as const,
  estimatedFieldRank: 1,
  estimatedFieldSize: 3,
  expectedBuildCount: 4,
  sideA: 2,
  sideB: 2,
  outcomes: baseOutcome,
  prompts: [{ ...baseOutcome, id: "p1", label: "Prompt 1" }],
  opponents: [{ ...baseOutcome, id: "o1", label: "Opponent 1" }],
};

function renderWithConfidence(confidence: number): string {
  return renderToStaticMarkup(
    React.createElement(ResultsDashboard, {
      variants: [{ ...baseVariant, confidence }],
    }),
  );
}

for (const [confidence, expectedText, expectedWidth] of [
  [0.5, "50%", "50%"],
  [0, "0%", "0%"],
  [1, "100%", "100%"],
  [0.86, "86%", "86%"],
] as const) {
  const html = renderWithConfidence(confidence);
  assert.match(
    html,
    new RegExp(`>${expectedText}<`),
    `component receiving normalized confidence=${confidence} must render text '${expectedText}'`,
  );
  assert.match(
    html,
    new RegExp(`width:${expectedWidth}`, "i"),
    `component receiving normalized confidence=${confidence} must render a ${expectedWidth}-width bar`,
  );
}
assert.doesNotMatch(
  renderWithConfidence(0.5),
  /5000%/,
  "component receiving normalized confidence=0.5 must NOT render the inflated '5000%' value",
);

console.log("lab results dashboard confidence scale regression checks passed");
