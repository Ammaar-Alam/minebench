import assert from "node:assert/strict";
import {
  fitBradleyTerryConnectedComponent,
  promptStrengthConsistency,
  shrinkPromptStrengthRows,
} from "../../../lib/arena/stats";

const displayNames = new Map([
  ["model-a", "Model A"],
  ["model-b", "Model B"],
]);
const separatedFit = fitBradleyTerryConnectedComponent(
  ["model-a", "model-b"],
  [
    {
      modelAId: "model-a",
      modelBId: "model-b",
      pointsA: 20,
      pointsB: 0,
      total: 20,
    },
  ],
  displayNames,
);

assert.ok(
  separatedFit.every(
    (row) =>
      Number.isFinite(row.theta) &&
      Number.isFinite(row.strength) &&
      Number.isFinite(row.variance),
  ),
  "complete separation must still produce finite Bradley-Terry estimates",
);
assert.ok(
  separatedFit.every((row) => Math.abs(row.theta) < 5 && row.variance < 10),
  "the symmetric edge prior must keep a zero-win model from creating extreme variance",
);

const shrunk = shrinkPromptStrengthRows(
  separatedFit,
  displayNames,
  new Map([
    ["model-a", 0],
    ["model-b", 0],
  ]),
);
assert.ok(
  shrunk.every((row) => row.shrinkage != null && row.shrinkage > 0),
  "finite separated fits must retain prompt-local signal after shrinkage",
);

assert.equal(promptStrengthConsistency([100, 100, 75, 50, 0]), 0);
assert.equal(promptStrengthConsistency([80, 80, 80, 80, 80]), 100);
assert.equal(promptStrengthConsistency([100, 90, 80, 70]), null);

console.log("model consistency checks passed");
