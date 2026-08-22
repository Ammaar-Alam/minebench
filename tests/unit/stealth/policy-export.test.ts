import assert from "node:assert/strict";
import {
  ACTIVE_STEALTH_EXPERIMENT_STATUSES,
  canExportStealthVotes,
  hasReachedStealthVoteGoal,
  isStealthVoteGoalEnforced,
  normalizeStealthSlug,
  readStealthArenaShare,
  stealthVoteGoalProgress,
} from "../../../lib/stealth/policy";
import { serializeDeidentifiedStealthVotes } from "../../../lib/stealth/report";

assert.equal(readStealthArenaShare(undefined), 0.25);
assert.equal(readStealthArenaShare("0.5"), 0.5);
assert.equal(readStealthArenaShare("3"), 1);
assert.equal(readStealthArenaShare("-2"), 0);
assert.equal(readStealthArenaShare("invalid"), 0.25);
assert.equal(normalizeStealthSlug("  Frontier Lab / Run 7  "), "frontier-lab-run-7");

assert.deepEqual(ACTIVE_STEALTH_EXPERIMENT_STATUSES, ["ACTIVE"]);
assert.equal(canExportStealthVotes("ADMIN"), true);
assert.equal(canExportStealthVotes("MEMBER"), true);

assert.equal(isStealthVoteGoalEnforced({ targetDecisiveVotes: null, pauseAtGoal: true }), false);
assert.equal(isStealthVoteGoalEnforced({ targetDecisiveVotes: 10, pauseAtGoal: false }), false);
assert.equal(isStealthVoteGoalEnforced({ targetDecisiveVotes: 10, pauseAtGoal: true }), true);
assert.equal(hasReachedStealthVoteGoal({ targetDecisiveVotes: 10, pauseAtGoal: true }, 9), false);
assert.equal(hasReachedStealthVoteGoal({ targetDecisiveVotes: 10, pauseAtGoal: true }, 10), true);
assert.equal(hasReachedStealthVoteGoal({ targetDecisiveVotes: 10, pauseAtGoal: false }, 12), false);
assert.equal(stealthVoteGoalProgress(null, 12), null);
assert.equal(stealthVoteGoalProgress(10, 12), 1);

const csv = serializeDeidentifiedStealthVotes([
  {
    day: "2026-08-21",
    codename: "Orchid",
    prompt: "A castle, with towers",
    opponent: 'Public "Model"',
    variantSide: "B",
    choice: "WIN",
  },
]);
assert.equal(
  csv,
  'date,codename,prompt,opponent,variant_side,outcome\n2026-08-21,Orchid,"A castle, with towers","Public ""Model""",B,WIN\n',
);
assert.equal(csv.includes("session"), false);
assert.equal(csv.includes("matchup"), false);

console.log("stealth policy and deidentified export checks passed");
