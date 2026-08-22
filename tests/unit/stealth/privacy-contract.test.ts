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
  assert.match(buildRoute, /privateAccessOnly && !buildAccess/);
}
assert.match(read("app/api/arena/builds/[buildId]/route.ts"), /cache: buildAccess \? "no-store"/);
assert.match(read("app/api/arena/matchup/route.ts"), /cache: privateAccessOnly \? "no-store"/);

const generation = read("lib/stealth/generation.ts");
assert.doesNotMatch(generation, /prisma\.build\.upsert/);
assert.doesNotMatch(generation, /"x-upsert": "true"/);
assert.match(generation, /validateExistingBuildIdentity/);
assert.match(generation, /Existing stealth build cannot be replaced/);

const buildMetaCache = read("lib/arena/buildMetaCache.ts");
assert.match(buildMetaCache, /privateAccessOnly/);
assert.match(buildMetaCache, /stealthVariant/);
assert.match(buildMetaCache, /!row\.privateAccessOnly/);

const publication = read("lib/benchmark/publication.ts");
const ratedCohortGuard = publication.slice(
  publication.indexOf("export async function assertRatedModelCohortUnchanged"),
  publication.indexOf("export function runPublicationStep"),
);
assert.match(ratedCohortGuard, /stealthVariantId:\s*null/);

const leaderboardBuildRoute = read("app/api/leaderboard/builds/[buildId]/route.ts");
assert.match(leaderboardBuildRoute, /stealthVariant/);
assert.match(leaderboardBuildRoute, /Build not found/);

const labBuildRoute = read("app/api/lab/organizations/[orgSlug]/builds/[resultId]/route.ts");
assert.match(labBuildRoute, /getLabIdentity/);
assert.match(labBuildRoute, /identity\.user\.isMineBenchAdmin/);
assert.match(labBuildRoute, /stealthGenerationResult\.findFirst/);
assert.match(labBuildRoute, /organizationId !== organization\?\.id/);
assert.match(labBuildRoute, /createArenaBuildAccessToken/);
assert.match(labBuildRoute, /streamToken:/);
assert.doesNotMatch(labBuildRoute, /resolveBuildPayload/);
assert.doesNotMatch(labBuildRoute, /validateVoxelBuild/);
assert.match(labBuildRoute, /resultId: result\.id/);
assert.doesNotMatch(labBuildRoute, /voxelBuild[:,]/);

const resetElo = read("scripts/reset-elo.ts");
assert.match(resetElo, /vote\.deleteMany\(\{ where: \{ matchup: \{ stealthVariantId: null \} \} \}\)/);
assert.match(resetElo, /matchup\.deleteMany\(\{ where: \{ stealthVariantId: null \} \}\)/);
assert.doesNotMatch(resetElo, /stealthVariant\.updateMany/);

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
