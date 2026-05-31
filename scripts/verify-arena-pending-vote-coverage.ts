import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  applyArenaCoverageVoteDeltasToSamplingState,
  modelPromptKey,
  pairKey,
  pairPromptKey,
  type ArenaMatchupSamplingState,
} from "../lib/arena/coverage";

const coverageSource = readFileSync("lib/arena/coverage.ts", "utf8");
const migrationSources = readdirSync("prisma/migrations")
  .filter((entry) => entry !== "migration_lock.toml")
  .map((entry) => `prisma/migrations/${entry}/migration.sql`)
  .filter((migrationPath) => existsSync(migrationPath))
  .map((migrationPath) => readFileSync(migrationPath, "utf8"))
  .join("\n");

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
      appliedVoteJobIds: new Set(),
    },
  };
}

const state = makeState();
applyArenaCoverageVoteDeltasToSamplingState(state, [
  { voteJobId: "job-1", modelAId: "model-a", modelBId: "model-b", promptId: "prompt-1", decisiveVotes: 1 },
  { voteJobId: "job-2", modelAId: "model-a", modelBId: "model-b", promptId: "prompt-1", decisiveVotes: 1 },
  { voteJobId: "job-3", modelAId: "model-b", modelBId: "model-a", promptId: "prompt-2", decisiveVotes: 1 },
  { voteJobId: "job-2", modelAId: "model-a", modelBId: "model-b", promptId: "prompt-1", decisiveVotes: 1 },
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

const persistedState = makeState();
applyArenaCoverageVoteDeltasToSamplingState(persistedState, [
  { modelAId: "model-a", modelBId: "model-b", promptId: "prompt-1", decisiveVotes: 1 },
]);
persistedState.coverage.appliedVoteJobIds.add("job-drained");
applyArenaCoverageVoteDeltasToSamplingState(persistedState, [
  { voteJobId: "job-drained", modelAId: "model-a", modelBId: "model-b", promptId: "prompt-1", decisiveVotes: 1 },
]);

assert.equal(persistedState.coverage.modelPromptDecisiveVotes.get(modelAPrompt1), 1);
assert.equal(persistedState.coverage.pairDecisiveVotes.get(unorderedPair), 1);
assert.ok(
  coverageSource.includes("Prisma.TransactionIsolationLevel.RepeatableRead"),
  "persisted coverage and vote-job rows should be read from one repeatable-read snapshot",
);
assert.ok(
  /recordArenaVoteInSamplingCache[\s\S]*applySamplingStateMutation\(\(state\) =>/.test(coverageSource),
  "drained vote rating updates should replay into in-flight sampling refreshes",
);
assert.ok(
  coverageSource.includes("\"processedAt\" IS NOT NULL"),
  "recent processed vote jobs should mark replayed deltas as already applied",
);
assert.ok(
  !coverageSource.includes("const [pairPromptRows, pendingVoteRows] = await Promise.all"),
  "persisted coverage and pending jobs should not be read with independent snapshots",
);
assert.ok(
  /const eligiblePromptIds = eligiblePrompts\.map[\s\S]*if \(eligiblePromptIds\.length === 0 \|\| eligibleModelIds\.length === 0\) \{\s*return emptyCoverageState\(\);\s*\}/.test(
    coverageSource,
  ),
  "raw coverage queries should guard the exact arrays passed into Prisma.join",
);
assert.ok(
  migrationSources.includes('"ArenaVoteJob_sampling_coverage_snapshot_idx"'),
  "vote-job snapshot refreshes should have a covering partial index",
);
assert.ok(
  migrationSources.includes('ON "ArenaVoteJob" ("processedAt", "promptId", "modelAId", "modelBId")'),
  "vote-job snapshot index should lead with processedAt and include prompt/model filters",
);
assert.ok(
  migrationSources.includes('WHERE "choice" IN (\'A\', \'B\')'),
  "vote-job snapshot index should be limited to decisive choices",
);

console.log("arena pending vote coverage checks passed");
