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
