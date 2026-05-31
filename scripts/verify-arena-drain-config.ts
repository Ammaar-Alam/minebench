import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveArenaDrainRequestLimits,
  shouldScheduleArenaVoteJobDrainAfterResponse,
  shouldIncludeArenaDrainStatus,
} from "../lib/arena/drainConfig";

const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  crons?: Array<{ path?: string; schedule?: string }>;
};
const voteRouteSource = readFileSync("app/api/arena/vote/route.ts", "utf8");

const voteDefaults = resolveArenaDrainRequestLimits(
  new URL("https://minebench.ai/api/admin/arena/drain-vote-jobs"),
  "vote",
);
assert.deepEqual(voteDefaults, { maxJobs: 256, maxMs: 15_000 });

const shownDefaults = resolveArenaDrainRequestLimits(
  new URL("https://minebench.ai/api/admin/arena/drain-shown-jobs"),
  "shown",
);
assert.deepEqual(shownDefaults, { maxJobs: 512, maxMs: 15_000 });

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

const voteCron = vercelConfig.crons?.find((cron) =>
  cron.path?.startsWith("/api/admin/arena/drain-vote-jobs"),
);
assert.ok(voteCron, "vote drain cron should be configured");
assert.equal(voteCron.schedule, "10,25,40,55 * * * *");
assert.deepEqual(
  resolveArenaDrainRequestLimits(new URL(`https://minebench.ai${voteCron.path}`), "vote"),
  { maxJobs: 256, maxMs: 15_000 },
);

const shownCron = vercelConfig.crons?.find((cron) =>
  cron.path?.startsWith("/api/admin/arena/drain-shown-jobs"),
);
assert.ok(shownCron, "shown drain cron should be configured");
assert.equal(shownCron.schedule, "5,20,35,50 * * * *");
assert.deepEqual(
  resolveArenaDrainRequestLimits(new URL(`https://minebench.ai${shownCron.path}`), "shown"),
  { maxJobs: 512, maxMs: 15_000 },
);

assert.equal(shouldScheduleArenaVoteJobDrainAfterResponse(1, undefined), true);
assert.equal(shouldScheduleArenaVoteJobDrainAfterResponse(4, "0"), false);
assert.equal(shouldScheduleArenaVoteJobDrainAfterResponse(0, "1"), false);
assert.ok(
  voteRouteSource.includes("recordArenaVoteQueuedForSampling"),
  "vote route should immediately update sampling coverage for queued decisive votes",
);
assert.ok(
  voteRouteSource.includes("scheduleArenaVoteJobDrain()"),
  "vote route should schedule the bounded vote job drainer after successful queue writes",
);

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
