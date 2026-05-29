import assert from "node:assert/strict";
import {
  resolveArenaDrainRequestLimits,
  shouldIncludeArenaDrainStatus,
} from "../lib/arena/drainConfig";

const voteDefaults = resolveArenaDrainRequestLimits(
  new URL("https://minebench.ai/api/admin/arena/drain-vote-jobs"),
  "vote",
);
assert.deepEqual(voteDefaults, { maxJobs: 32, maxMs: 5_000 });

const shownDefaults = resolveArenaDrainRequestLimits(
  new URL("https://minebench.ai/api/admin/arena/drain-shown-jobs"),
  "shown",
);
assert.deepEqual(shownDefaults, { maxJobs: 64, maxMs: 5_000 });

const cappedVote = resolveArenaDrainRequestLimits(
  new URL("https://minebench.ai/api/admin/arena/drain-vote-jobs?maxJobs=10000&maxMs=50000"),
  "vote",
);
assert.deepEqual(cappedVote, { maxJobs: 256, maxMs: 15_000 });

const cappedShown = resolveArenaDrainRequestLimits(
  new URL("https://minebench.ai/api/admin/arena/drain-shown-jobs?maxJobs=10000&maxMs=50000"),
  "shown",
);
assert.deepEqual(cappedShown, { maxJobs: 512, maxMs: 15_000 });

assert.equal(
  shouldIncludeArenaDrainStatus(
    new URL("https://minebench.ai/api/admin/arena/drain-vote-jobs"),
  ),
  false,
);
assert.equal(
  shouldIncludeArenaDrainStatus(
    new URL("https://minebench.ai/api/admin/arena/drain-vote-jobs?status=1"),
  ),
  true,
);

console.log("arena drain config checks passed");
