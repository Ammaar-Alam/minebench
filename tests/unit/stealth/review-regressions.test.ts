import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const settings = read("app/lab/[orgSlug]/experiments/[experimentId]/settings/page.tsx");
assert.match(settings, /checkpointSetOpen = mutable && workspace\.checkpointSetFrozenAt === null/);
assert.match(settings, /\{checkpointSetOpen \? \(/);

const nextConfig = read("next.config.ts");
assert.doesNotMatch(nextConfig, /bodySizeLimit/);

const cohortUpload = read("components/lab/CohortUploadForm.tsx");
assert.match(cohortUpload, /target\.signedUrl/);
assert.match(cohortUpload, /method: "PUT"/);
assert.match(cohortUpload, /formData\.delete\("cohortFile"\)/);
assert.match(cohortUpload, /if \(!result\.ok\)/);
assert.doesNotMatch(cohortUpload, /from "tus-js-client"/);

const service = read("lib/stealth/service.ts");
assert.match(service, /createSignedUploadUrl/);
assert.match(service, /signedUrl: data\.signedUrl/);
assert.match(service, /expiresAt: \{ gt: new Date\(\) \}/);
const workspaceList = service.slice(
  service.indexOf("export async function listStealthEvaluationWorkspaces"),
  service.indexOf("export async function getStealthEvaluationWorkspace"),
);
assert.match(workspaceList, /readableStealthEvaluationWhere/);
assert.match(workspaceList, /evaluation\.status === "CLOSED"/);

function assertOrder(body: string, first: string, second: string, message: string) {
  const firstIndex = body.indexOf(first);
  const secondIndex = body.indexOf(second);
  assert.ok(firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex, message);
}

function functionBody(source: string, functionName: string): string {
  const start = source.indexOf(`export async function ${functionName}`);
  const end = source.indexOf("\nexport async function ", start + 1);
  assert.ok(start >= 0, `${functionName} must exist`);
  return source.slice(start, end < 0 ? undefined : end);
}

const workspaceDetail = functionBody(service, "getStealthEvaluationWorkspace");
assertOrder(
  workspaceDetail,
  "reclaimStaleStealthGenerationRuns",
  "stealthExperiment.findFirst",
  "workspace reads must reclaim expired generation reservations before reporting status",
);
const uploadTarget = functionBody(service, "createStealthCohortUploadTarget");
assert.match(uploadTarget, /expiresAt: \{ gt: now \}/);
const activation = functionBody(service, "activateStealthEvaluation");
assert.match(activation, /generationRuns:[\s\S]*status: "SUCCEEDED"/);
assert.match(activation, /promptCohortId !== BENCHMARK_PROMPT_COHORT_ID/);
const closeEvaluation = functionBody(service, "closeStealthEvaluation");
assertOrder(
  closeEvaluation,
  'data: { status: "PAUSED", endedAt, retentionDays }',
  "drainStealthVoteJobsForExperiment",
  "closure must become non-votable before draining accepted votes",
);
const closeReservation = closeEvaluation.slice(
  0,
  closeEvaluation.indexOf("drainStealthVoteJobsForExperiment"),
);
assert.match(closeReservation, /endpointEnabled: false/);
assert.match(closeReservation, /stealthEndpointCredential\.deleteMany/);
assert.match(closeReservation, /retentionDays/);
const staleReclaimer = functionBody(service, "reclaimStaleStealthGenerationRuns");
assert.match(staleReclaimer, /complete[\s\S]*status: "READY"/);
assert.match(staleReclaimer, /complete[\s\S]*stealthEndpointCredential\.deleteMany/);
const uploadCompletion = functionBody(service, "completeUploadedStealthCohort");
assert.match(uploadCompletion, /complete \? "SUCCEEDED"/);
assert.match(uploadCompletion, /complete \? "READY"/);
assert.match(functionBody(service, "resumeStealthEvaluation"), /if \(experiment\.endedAt\)/);
assert.doesNotMatch(service, /for \(let page = 1; page <= 10/);
assert.match(service, /if \(!data\.nextPage\) break/);

for (const functionName of ["disableStealthEndpoint", "recordStealthReleaseMapping"]) {
  const start = service.indexOf(`export async function ${functionName}`);
  const end = service.indexOf("\nexport async function ", start + 1);
  const body = service.slice(start, end < 0 ? undefined : end);
  assert.ok(start >= 0, `${functionName} must exist`);
  assertOrder(
    body,
    "lockExperiment(tx",
    "lockVariant(tx",
    `${functionName} must lock the evaluation before its checkpoint`,
  );
}

const generationRun = read("lib/stealth/generationRun.ts");
assert.match(generationRun, /promptCohortId !== BENCHMARK_PROMPT_COHORT_ID/);
assert.match(generationRun, /abortSignal:/);
assert.match(generationRun, /process\.env\.OPENAI_REQUEST_TIMEOUT_MS/);
for (const functionName of [
  "failStealthGenerationRun",
  "refreshStealthGenerationProgress",
  "finishStealthGenerationRun",
]) {
  const resolvedStart = generationRun.indexOf(`function ${functionName}`);
  const end = generationRun.indexOf("\nexport async function ", resolvedStart + 1);
  const body = generationRun.slice(resolvedStart, end < 0 ? undefined : end);
  assert.ok(resolvedStart >= 0, `${functionName} must exist`);
  assertOrder(
    body,
    "lockGenerationContext(tx",
    "stealthVariant.update",
    `${functionName} must lock the evaluation before changing its checkpoint`,
  );
}
assert.doesNotMatch(
  generationRun,
  /lockGenerationRun\(tx/,
  "generation transactions must use the shared experiment-first lock helper",
);
assert.match(service, /if \(hasSupabaseStorageConfig\(\)\) \{[\s\S]*listStealthBuildStorageRefs/);

const generationSource = read("lib/stealth/generation.ts");
assert.match(
  generationSource,
  /isMissingStealthBuildPayload\(error\)[\s\S]*uploadPreparedPayload\(/,
);
assert.match(generationRun, /isMissingStealthBuildPayload\(error\)/);
assert.match(generationRun, /deleteUnacceptedStealthBuild\(existing\.id\)/);
assert.match(generationRun, /sanitizeOperationalError\([\s\S]*configuredApiKey/);
assert.match(generationRun, /complete \? "SUCCEEDED"/);
const unacceptedCleanup = generationSource.slice(
  generationSource.indexOf("export async function deleteUnacceptedStealthBuild"),
  generationSource.indexOf("export function isMissingStealthBuildPayload"),
);
assertOrder(
  unacceptedCleanup,
  'SELECT id FROM "Build" WHERE id = ${buildId} FOR UPDATE',
  "deleteArenaBuildArtifacts",
  "unaccepted cleanup must claim the Build before deleting storage",
);

const retention = read("lib/stealth/retention.ts");
assert.match(retention, /retentionDeleteAt: \{ gt: now \}/);
for (const path of [
  "lib/stealth/service.ts",
  "lib/stealth/report.ts",
  "app/api/lab/organizations/[orgSlug]/experiments/[experimentId]/export/route.ts",
  "app/api/lab/organizations/[orgSlug]/builds/[resultId]/route.ts",
]) {
  assert.match(read(path), /readableStealthEvaluationWhere/);
}

const report = read("lib/stealth/report.ts");
assert.match(report, /createdAt: string/);
assert.match(report, /ORDER BY vote\."createdAt" ASC, vote\.id ASC/);
assert.match(report, /if \(persisted && !result\.build\) continue/);
assert.match(report, /stealthGenerationResults: \{ some: \{ status: "READY" \} \}/);
assert.match(report, /isBaseline: false/);
assert.match(report, /function safeGenerationError[\s\S]*return error/);

const sampling = read("lib/stealth/sampling.ts");
assert.match(
  sampling,
  /voteJobs: \{ where: \{ processedAt: null, choice: \{ in: \["A", "B"\] \} \} \}/,
);
const matchupPicker = functionBody(sampling, "pickStealthMatchup");
assert.match(matchupPicker, /voteJobs:[\s\S]*processedAt: null/);
assert.match(matchupPicker, /hasReachedStealthVoteGoal/);

const buildsPage = read("app/lab/[orgSlug]/experiments/[experimentId]/builds/page.tsx");
assert.match(buildsPage, /promptCohortCurrent/);
assert.match(buildsPage, /currentExpectedBuildCount/);
const overviewPage = read("app/lab/[orgSlug]/experiments/[experimentId]/overview/page.tsx");
assert.match(overviewPage, /canResume/);
const adminEvaluationPage = read("app/admin/private-evaluations/[experimentId]/page.tsx");
assert.match(adminEvaluationPage, /canResume/);
const arena = read("components/arena/Arena.tsx");
assert.match(arena, /loadNextMatchup/);
const nextMatchupLoader = arena.slice(
  arena.indexOf("function loadNextMatchup"),
  arena.indexOf("async function handleVote"),
);
assert.doesNotMatch(nextMatchupLoader, /setReveal\(\{ kind: "none" \}\)/);

const voteJobs = read("lib/arena/voteJobs.ts");
assert.match(voteJobs, /drainStealthVoteJobsForExperiment/);
assert.doesNotMatch(voteJobs, /stealthExperimentId\?: string/);
assert.match(voteJobs, /ORDER BY "createdAt" ASC, "id" ASC/);
assert.match(service, /Votes are still settling/);

const generateVoxelBuild = read("lib/ai/generateVoxelBuild.ts");
assert.match(generateVoxelBuild, /reasoningEffort: args\.reasoning/);

const credentials = read("lib/stealth/credentials.ts");
assert.match(credentials, /protocol === "openrouter"[\s\S]*requireStructuredOutput/);

const signInActions = read("app/lab/sign-in/actions.ts");
assert.match(signInActions, /VERCEL_URL/);
assert.doesNotMatch(signInActions, /NODE_ENV === "production"[\s\S]*https:\/\/minebench\.ai/);

const voteRoute = read("app/api/arena/vote/route.ts");
assertOrder(
  voteRoute.slice(voteRoute.indexOf("const choice: VoteChoice")),
  "loadMatchupReveal",
  "withArenaWriteRetry",
  "vote reveal must load before the committing write",
);

const resultsPage = read("app/lab/[orgSlug]/experiments/[experimentId]/results/page.tsx");
assert.match(resultsPage, /rating: variant\.conservativeRating/);
const resultsDashboard = read("components/lab/ResultsDashboard.tsx");
assert.match(resultsDashboard, /worstFirst/);
assert.match(resultsDashboard, /title="Opponent field"[\s\S]*worstFirst/);

for (const path of ["lib/arena/buildSnapshotArtifacts.ts", "lib/arena/buildStream.ts"]) {
  assert.match(read(path), /uploadArenaBuildArtifact/);
}

const cli = read("scripts/stealth-eval.ts");
assert.match(cli, /positiveInt\(args, \["--concurrency"\], 1, 15\)/);
assert.doesNotMatch(cli, /for \(let page = 1; page <= 10/);
assert.match(cli, /if \(!data\.nextPage\) break/);

const actions = read("app/lab/[orgSlug]/actions.ts");
assert.match(actions, /completeUploadedStealthCohortFromStorage/);
assert.match(actions, /return \{ ok: false, error: sanitizeOperationalError\(error\) \}/);

const middleware = read("middleware.ts");
assert.match(middleware, /pathname\.startsWith\("\/admin\/private-evaluations"\)/);
assert.match(middleware, /isLabApi\s*\?\s*await/);

const exportRoute = read(
  "app/api/lab/organizations/[orgSlug]/experiments/[experimentId]/export/route.ts",
);
assert.match(exportRoute, /new ReadableStream<Uint8Array>/);
assert.match(exportRoute, /getDeidentifiedStealthVotePage/);

const evaluationLayout = read("app/lab/[orgSlug]/experiments/[experimentId]/layout.tsx");
assert.match(evaluationLayout, /workspace\.status === "CLOSED"\s*\? workspace\.checkpoints/);
assert.match(settings, /checkpoint\.source === "ENDPOINT"/);
assert.match(settings, /checkpoint\.status === "DRAFT" \|\| checkpoint\.status === "GENERATING"/);

const generation = read("lib/stealth/generation.ts");
assert.match(generation, /isExistingObjectUploadError/);
assert.match(generation, /assertStoredPayloadMatches/);
assert.match(generation, /promptSlug}-\$\{params\.sha256}\.json\.gz/);

const stagingRunner = read("scripts/with-staging-env.mjs");
assert.match(stagingRunner, /required\("STAGING_SUPABASE_PUBLISHABLE_KEY"\)/);
assert.match(stagingRunner, /required\("STAGING_STEALTH_CONFIG_ENCRYPTION_KEY"\)/);
assert.doesNotMatch(stagingRunner, /STAGING_SUPABASE_PUBLISHABLE_KEY\?\.trim\(\) \|\| ""/);

console.log("private evaluation review regression checks passed");
