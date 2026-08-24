import assert from "node:assert/strict";
import {
  BT_SCALE,
  INITIAL_RATING,
  computeOrdinalRanks,
  confidenceFromCi,
  confidenceInterval95,
  expectedScore,
  ratingToTheta,
  stabilityTier,
  thetaToRating,
  varianceToStandardError,
} from "../../../lib/arena/rating";

// 1. Scale conversions
assert.equal(thetaToRating(0), 1500, "theta=0 must correspond to center rating 1500");
assert.equal(ratingToTheta(1500), 0, "rating 1500 must correspond to theta 0");
const thetaOne = 1;
const expectedRating = 1500 + BT_SCALE;
assert.ok(
  Math.abs(thetaToRating(thetaOne) - expectedRating) < 1e-6,
  "theta=1 must add 400/ln(10) to 1500",
);
assert.ok(
  Math.abs(ratingToTheta(expectedRating) - thetaOne) < 1e-6,
  "ratingToTheta inverse must match thetaToRating",
);

// 2. Variance -> SE -> 95% CI
const se = varianceToStandardError(0.01);
assert.ok(Math.abs(se - 0.1 * BT_SCALE) < 1e-6, "SE must equal sqrt(var) * BT_SCALE");
const ci = confidenceInterval95(se);
assert.ok(
  Math.abs(ci - 1.959963984540054 * se) < 1e-6,
  "95% CI must equal 1.95996 * SE",
);

// 3. Confidence from CI width
assert.equal(confidenceFromCi(10), 92, "CI of 10 should produce ~92% confidence");
assert.equal(confidenceFromCi(40), 66, "CI of 40 should produce ~66% confidence");
assert.ok(
  confidenceFromCi(10) > confidenceFromCi(30) &&
    confidenceFromCi(30) > confidenceFromCi(50),
  "Confidence must strictly decrease as CI width grows",
);

// 4. Stability Tiers
assert.equal(
  stabilityTier({ decisiveVotes: 250, promptCoverage: 0.95, ci95: 18 }),
  "Stable",
  "High votes, high coverage, tight CI should be Stable",
);
assert.equal(
  stabilityTier({ decisiveVotes: 100, promptCoverage: 0.85, ci95: 30 }),
  "Established",
  "Moderate votes, coverage >= 80%, CI <= 35 should be Established",
);
assert.equal(
  stabilityTier({ decisiveVotes: 30, promptCoverage: 0.5, ci95: 60 }),
  "Provisional",
  "Low votes or wide CI should be Provisional",
);

// 5. Ordinal Ranking
const modelA = {
  id: "a",
  rating: 2100,
  variance: 0.005,
  standardError: 12.28,
  ci95: 24.0,
};
const modelB = {
  id: "b",
  rating: 2095,
  variance: 0.005,
  standardError: 12.28,
  ci95: 24.0,
};
const modelC = {
  id: "c",
  rating: 1950,
  variance: 0.005,
  standardError: 12.28,
  ci95: 24.0,
};

const ranked = computeOrdinalRanks([modelA, modelB, modelC]);
assert.equal(ranked[0].rank, 1, "Model A should be rank 1");
assert.equal(ranked[1].rank, 2, "Model B should be rank 2");
assert.equal(ranked[2].rank, 3, "Model C should be rank 3");

// 6. Expected score
assert.ok(Math.abs(expectedScore(1500, 1500) - 0.5) < 1e-6, "Equal ratings have 50% expected win rate");
assert.ok(Math.abs(expectedScore(1900, 1500) - 0.90909) < 1e-4, "+400 rating delta has ~90.9% win rate");

console.log("Bradley-Terry rating module unit tests passed");
