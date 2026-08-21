import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const migration = read("prisma/migrations/20260821060000_stealth_evaluations/migration.sql");
assert.match(migration, /ALTER TABLE "StealthEndpointCredential" ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /REVOKE ALL ON "StealthEndpointCredential" FROM authenticated/);
assert.match(migration, /ON "StealthEndpointCredential" FOR ALL TO authenticated\s+USING \(false\) WITH CHECK \(false\)/);
assert.match(migration, /CHECK \("attempts" >= 0 AND "generationTimeMs" >= 0\)/);

const matchupRoute = read("app/api/arena/matchup/route.ts");
assert.equal((matchupRoute.match(/model: null/g) ?? []).length, 2);
assert.match(matchupRoute, /stealthVariantId: picked\.stealthVariantId/);
assert.match(matchupRoute, /createArenaBuildAccessToken/);
assert.match(matchupRoute, /checksum: null/);

for (const path of [
  "app/api/arena/builds/[buildId]/route.ts",
  "app/api/arena/builds/[buildId]/stream/route.ts",
]) {
  const buildRoute = read(path);
  assert.match(buildRoute, /parseArenaBuildAccessToken/);
  assert.match(buildRoute, /private, no-store/);
}

const voteRoute = read("app/api/arena/vote/route.ts");
assert.match(voteRoute, /const responseBody: ArenaVoteResponse/);
assert.match(voteRoute, /provider: "Stealth", displayName: model\.stealthVariant\.codename/);
assert.match(voteRoute, /z\.literal\("SKIP"\)/);
const skipReveal = voteRoute.slice(
  voteRoute.indexOf('if (action === "SKIP")'),
  voteRoute.indexOf("const choice: VoteChoice = action"),
);
assert.match(skipReveal, /loadMatchupReveal/);
assert.match(skipReveal, /return respondJson\(responseBody/);
assert.doesNotMatch(skipReveal, /inserted_vote|ArenaVoteJob/);
assert.match(voteRoute, /queuedVoteJobInput && !queuedVoteJobInput\.stealthVariantId/);

const voteJobs = read("lib/arena/voteJobs.ts");
const variantLoader = voteJobs.slice(
  voteJobs.indexOf("async function loadStealthVariantsForVoteJobs"),
  voteJobs.indexOf("async function applyBatchedStealthVariantUpdates"),
);
assert.doesNotMatch(variantLoader, /status[^\n]*ACTIVE/);
const privateBranch = voteJobs.indexOf("if (job.stealthVariantId)");
const publicTouch = voteJobs.indexOf("publicTouchedModelIds.add", privateBranch);
assert.ok(privateBranch >= 0 && publicTouch > privateBranch);
assert.match(voteJobs.slice(privateBranch, publicTouch), /applyStealthRatingVote/);
assert.match(voteJobs.slice(privateBranch, publicTouch), /continue/);

for (const path of [
  "app/api/leaderboard/route.ts",
  "app/api/sandbox/benchmark/route.ts",
  "lib/arena/coverage.ts",
  "lib/arena/eligibility.ts",
  "lib/arena/stats.ts",
]) {
  assert.match(read(path), /stealthVariant|StealthVariant/, `${path} must exclude private variants`);
}

assert.match(
  read("lib/arena/coverage.ts"),
  /matchup\."stealthVariantId" IS NULL/,
  "coverage rebuilds must exclude private votes",
);

console.log("stealth privacy boundary checks passed");
