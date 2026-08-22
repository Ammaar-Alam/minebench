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
assert.doesNotMatch(cohortUpload, /from "tus-js-client"/);

const service = read("lib/stealth/service.ts");
assert.match(service, /createSignedUploadUrl/);
assert.match(service, /signedUrl: data\.signedUrl/);

const workflow = read("workflows/stealth-generation.ts");
assert.match(workflow, /Promise\.allSettled/);
assert.match(workflow, /index \+= plan\.concurrency/);
assert.match(workflow, /await failStealthGeneration\(/);

const cli = read("scripts/stealth-eval.ts");
assert.match(cli, /positiveInt\(args, \["--concurrency"\], 1, 4\)/);
assert.match(cli, /failStealthGenerationRun\(runId, error\)/);

const actions = read("app/lab/[orgSlug]/actions.ts");
assert.match(actions, /completeUploadedStealthCohortFromStorage/);
assert.match(actions, /failStealthGenerationRun\(runId, error\)/);

const middleware = read("middleware.ts");
assert.match(middleware, /pathname\.startsWith\("\/admin\/private-evaluations"\)/);

const generation = read("lib/stealth/generation.ts");
assert.match(generation, /isExistingObjectUploadError/);
assert.match(generation, /assertStoredPayloadMatches/);
assert.match(generation, /promptSlug}-\$\{params\.sha256}\.json\.gz/);

console.log("private evaluation review regression checks passed");
