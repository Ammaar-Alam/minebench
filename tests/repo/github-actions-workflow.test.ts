import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const contributing = readFileSync(".github/CONTRIBUTING.md", "utf8");
const pullRequestTemplate = readFileSync(".github/pull_request_template.md", "utf8");

function includesInJob(jobId: string, expected: string): boolean {
  const jobStart = ciWorkflow.indexOf(`  ${jobId}:`);
  if (jobStart < 0) return false;
  const nextJob = ciWorkflow.slice(jobStart + 1).search(/\n  [a-z0-9-]+:\n/);
  const jobText = nextJob < 0 ? ciWorkflow.slice(jobStart) : ciWorkflow.slice(jobStart, jobStart + 1 + nextJob);
  return jobText.includes(expected);
}

assert.ok(ciWorkflow.includes("name: MineBench Quality Gates"));
assert.equal(ciWorkflow.includes("  lint-and-build:"), false);
assert.equal(ciWorkflow.includes("actions/checkout@v4"), false);
assert.equal(ciWorkflow.includes("actions/setup-node@v4"), false);
assert.equal(ciWorkflow.includes("pnpm/action-setup@v4"), false);
const staleSummaryPhrases = [
  `${["opt", "in"].join("-")} ${["performance", "budgets"].join(" ")}`,
  ["default", "gate"].join(" "),
];
for (const phrase of staleSummaryPhrases) {
  assert.equal(ciWorkflow.includes(phrase), false);
}
assert.ok(ciWorkflow.includes("actions/checkout@v6"));
assert.ok(ciWorkflow.includes("actions/setup-node@v6"));
assert.ok(ciWorkflow.includes("pnpm/action-setup@v6"));

assert.ok(includesInJob("static-analysis", 'name: "Quality / Static Analysis"'));
assert.ok(includesInJob("static-analysis", "run: pnpm lint"));
assert.ok(includesInJob("static-analysis", "GITHUB_STEP_SUMMARY"));

assert.ok(includesInJob("regression-tests", 'name: "Quality / Regression Tests"'));
assert.ok(includesInJob("regression-tests", "run: pnpm test"));
assert.ok(includesInJob("regression-tests", "DATABASE_URL"));
assert.ok(includesInJob("regression-tests", "DIRECT_URL"));
assert.ok(includesInJob("regression-tests", "GITHUB_STEP_SUMMARY"));

assert.ok(includesInJob("production-build", 'name: "Quality / Production Build"'));
assert.ok(includesInJob("production-build", "run: pnpm build"));
assert.ok(includesInJob("production-build", "DATABASE_URL"));
assert.ok(includesInJob("production-build", "DIRECT_URL"));
assert.ok(includesInJob("production-build", "GITHUB_STEP_SUMMARY"));

assert.ok(contributing.includes("pnpm check"));
assert.ok(contributing.includes("tests/integration/voxel-export.test.ts"));
assert.equal(contributing.includes("scripts/verify-voxel-export.ts"), false);

assert.ok(pullRequestTemplate.includes("`pnpm check` passes"));
assert.ok(pullRequestTemplate.includes("`pnpm test` passes"));
assert.equal(pullRequestTemplate.includes("`pnpm lint` passes"), false);

console.log("github actions workflow checks passed");
