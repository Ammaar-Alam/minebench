import assert from "node:assert/strict";
import { applyStealthRatingVote } from "../../../lib/stealth/rating";

const initial = {
  eloRating: 1500,
  glickoRd: 350,
  glickoVolatility: 0.06,
  conservativeRating: 800,
  winCount: 0,
  lossCount: 0,
  drawCount: 0,
  bothBadCount: 0,
};
const publicAnchor = {
  eloRating: 1620,
  glickoRd: 70,
  glickoVolatility: 0.06,
};
const anchorBefore = structuredClone(publicAnchor);

const win = applyStealthRatingVote({
  variant: initial,
  publicAnchor,
  variantSide: "A",
  choice: "A",
});
assert.equal(win.winCount, 1);
assert.equal(win.lossCount, 0);
assert.ok(win.eloRating > initial.eloRating);
assert.deepEqual(publicAnchor, anchorBefore, "a stealth vote must not mutate its public anchor");

const loss = applyStealthRatingVote({
  variant: initial,
  publicAnchor,
  variantSide: "B",
  choice: "A",
});
assert.equal(loss.lossCount, 1);
assert.ok(loss.eloRating < initial.eloRating);

const tie = applyStealthRatingVote({
  variant: initial,
  publicAnchor,
  variantSide: "B",
  choice: "TIE",
});
assert.equal(tie.drawCount, 1);

const bothBad = applyStealthRatingVote({
  variant: initial,
  publicAnchor,
  variantSide: "A",
  choice: "BOTH_BAD",
});
assert.equal(bothBad.bothBadCount, 1);
assert.equal(bothBad.eloRating, initial.eloRating);
assert.deepEqual(initial, {
  eloRating: 1500,
  glickoRd: 350,
  glickoVolatility: 0.06,
  conservativeRating: 800,
  winCount: 0,
  lossCount: 0,
  drawCount: 0,
  bothBadCount: 0,
});

console.log("stealth rating isolation checks passed");
