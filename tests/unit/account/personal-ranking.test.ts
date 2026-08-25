import assert from "node:assert/strict";
import {
  rankPersonalModels,
  type PersonalOutcomeAggregate,
} from "../../../lib/account/personalRanking";
import type { GlobalModelBradleyTerryStats } from "../../../lib/arena/stats";

function globalModel(id: string, displayName: string): GlobalModelBradleyTerryStats {
  return {
    id,
    key: `provider_${id}`,
    provider: "Provider",
    displayName,
    theta: 0,
    rawTheta: 0,
    strength: 1,
    variance: 1,
    standardError: 1,
    ci95: 1,
    rating: 1500,
    rankScore: 1500,
    rank: 1,
    confidence: 0,
  };
}

const outcomes: PersonalOutcomeAggregate[] = [
  { modelId: "a", wins: 1, losses: 4, ties: 0, bothBad: 2, votes: 7 },
  { modelId: "b", wins: 8, losses: 2, ties: 0, bothBad: 2, votes: 12 },
  { modelId: "c", wins: 1, losses: 4, ties: 0, bothBad: 0, votes: 5 },
];

const ranked = rankPersonalModels({
  pairs: [
    { modelAId: "a", modelBId: "b", pointsA: 1, pointsB: 4, total: 5 },
    { modelAId: "b", modelBId: "c", pointsA: 4, pointsB: 1, total: 5 },
  ],
  outcomes,
  globalModels: [globalModel("a", "Alpha"), globalModel("b", "Beta"), globalModel("c", "Gamma")],
  alphaByModelId: new Map([["a", 0], ["b", 0], ["c", 0]]),
});

assert.equal(ranked.length, 3);
assert.equal(ranked[0].displayName, "Beta");
assert.equal(ranked[0].rank, 1);
assert.equal(ranked[0].wins, 8);
assert.equal(ranked[0].bothBad, 2, "both-bad remains visible but does not enter the fit");
assert.deepEqual(ranked.map((model) => model.rank), [1, 2, 3]);

assert.deepEqual(
  rankPersonalModels({
    pairs: [],
    outcomes,
    globalModels: [globalModel("a", "Alpha"), globalModel("b", "Beta")],
    alphaByModelId: new Map(),
  }),
  [],
);

console.log("personal ranking checks passed");
