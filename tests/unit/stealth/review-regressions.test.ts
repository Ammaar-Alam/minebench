import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const settings = read("app/lab/[orgSlug]/experiments/[experimentId]/settings/page.tsx");
assert.match(settings, /checkpointSetOpen = !readOnly && workspace\.checkpointSetFrozenAt === null/);
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
    "lockExperiment(tx",
    "stealthVariant.update",
    `${functionName} must lock the evaluation before changing its checkpoint`,
  );
}
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
assert.match(report, /isBaseline: false/);

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
assert.match(cli, /positiveInt\(args, \["--concurrency"\], 1, 4\)/);

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

console.log("private evaluation review regression checks passed");
