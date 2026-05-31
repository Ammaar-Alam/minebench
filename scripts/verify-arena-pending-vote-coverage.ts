import assert from "node:assert/strict";
import {
  applyArenaCoverageVoteDeltasToSamplingState,
  modelPromptKey,
  pairKey,
  pairPromptKey,
  type ArenaMatchupSamplingState,
} from "../lib/arena/coverage";

function makeState(): ArenaMatchupSamplingState {
  return {
    prompts: [
      { id: "prompt-1", text: "Prompt 1", modelIds: ["model-a", "model-b"] },
      { id: "prompt-2", text: "Prompt 2", modelIds: ["model-a", "model-b"] },
    ],
    modelsById: new Map([
      [
        "model-a",
        {
          id: "model-a",
          key: "model_a",
          provider: "test",
          displayName: "Model A",
          eloRating: 1500,
          conservativeRating: 1300,
          ratingDeviation: 200,
          shownCount: 0,
        },
      ],
      [
        "model-b",
        {
          id: "model-b",
          key: "model_b",
          provider: "test",
          displayName: "Model B",
          eloRating: 1500,
          conservativeRating: 1300,
          ratingDeviation: 200,
          shownCount: 0,
        },
      ],
    ]),
    promptIdsByModelId: new Map([
      ["model-a", new Set(["prompt-1", "prompt-2"])],
      ["model-b", new Set(["prompt-1", "prompt-2"])],
    ]),
    buildsByModelPromptKey: new Map(),
    coverage: {
      modelPromptDecisiveVotes: new Map(),
      pairDecisiveVotes: new Map(),
      pairPromptCounts: new Map(),
      pairPromptDecisiveVotes: new Map(),
      promptCoverageByModelId: new Map([
        ["model-a", 0],
        ["model-b", 0],
      ]),
      promptDecisiveTotals: new Map(),
    },
  };
}

const state = makeState();
applyArenaCoverageVoteDeltasToSamplingState(state, [
  { modelAId: "model-a", modelBId: "model-b", promptId: "prompt-1", decisiveVotes: 1 },
  { modelAId: "model-a", modelBId: "model-b", promptId: "prompt-1", decisiveVotes: 1 },
  { modelAId: "model-b", modelBId: "model-a", promptId: "prompt-2", decisiveVotes: 1 },
]);

const modelAPrompt1 = modelPromptKey("model-a", "prompt-1");
const modelBPrompt1 = modelPromptKey("model-b", "prompt-1");
const modelAPrompt2 = modelPromptKey("model-a", "prompt-2");
const unorderedPair = pairKey("model-b", "model-a");

assert.equal(state.coverage.modelPromptDecisiveVotes.get(modelAPrompt1), 2);
assert.equal(state.coverage.modelPromptDecisiveVotes.get(modelBPrompt1), 2);
assert.equal(state.coverage.modelPromptDecisiveVotes.get(modelAPrompt2), 1);
assert.equal(state.coverage.pairDecisiveVotes.get(unorderedPair), 3);
assert.equal(state.coverage.pairPromptCounts.get(unorderedPair), 2);
assert.equal(
  state.coverage.pairPromptDecisiveVotes.get(pairPromptKey("model-a", "model-b", "prompt-1")),
  2,
);
assert.equal(state.coverage.promptDecisiveTotals.get("prompt-1"), 2);
assert.equal(state.coverage.promptDecisiveTotals.get("prompt-2"), 1);
assert.equal(state.coverage.promptCoverageByModelId.get("model-a"), 0.5);
assert.equal(state.coverage.promptCoverageByModelId.get("model-b"), 0.5);

console.log("arena pending vote coverage checks passed");
