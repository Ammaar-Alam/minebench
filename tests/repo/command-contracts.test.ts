import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Structural wiring only: the commands and CI jobs exist and run the right
// steps; versions and step details belong to CI itself

type PackageJson = {
  scripts?: Record<string, string>;
};

const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as PackageJson).scripts ?? {};

assert.equal(scripts.test, "tsx tests/run.ts");
assert.equal(scripts.check, "pnpm lint && pnpm test && pnpm build");
assert.ok(scripts.lint, "a lint script should exist");
assert.ok(scripts.build, "a build script should exist");

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
assert.ok(ciWorkflow.includes("run: pnpm lint"), "CI should run lint");
assert.ok(ciWorkflow.includes("run: pnpm test"), "CI should run the test suite");
assert.ok(ciWorkflow.includes("run: pnpm build"), "CI should run the production build");

console.log("command contract checks passed");
