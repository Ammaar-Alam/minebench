import assert from "node:assert/strict";
import {
  canExportStealthVotes,
  normalizeStealthSlug,
  readStealthArenaShare,
} from "../../../lib/stealth/policy";
import { serializeDeidentifiedStealthVotes } from "../../../lib/stealth/report";

assert.equal(readStealthArenaShare(undefined), 0.25);
assert.equal(readStealthArenaShare("0.5"), 0.5);
assert.equal(readStealthArenaShare("3"), 1);
assert.equal(readStealthArenaShare("-2"), 0);
assert.equal(readStealthArenaShare("invalid"), 0.25);
assert.equal(normalizeStealthSlug("  Frontier Lab / Run 7  "), "frontier-lab-run-7");

assert.equal(canExportStealthVotes("OWNER"), true);
assert.equal(canExportStealthVotes("ADMIN"), true);
assert.equal(canExportStealthVotes("ANALYST"), true);
assert.equal(canExportStealthVotes("VIEWER"), false);

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
