import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type PackageJson = {
  scripts?: Record<string, string>;
};

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
const scripts = packageJson.scripts ?? {};
const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

assert.equal(scripts.test, "tsx tests/run.ts");
assert.equal(scripts["test:unit"], "tsx tests/run.ts tests/unit");
assert.equal(scripts["test:config"], "tsx tests/run.ts tests/config");
assert.equal(scripts["test:ui"], "tsx tests/run.ts tests/ui");
assert.equal(scripts["test:integration"], "tsx tests/run.ts tests/integration");
assert.equal(scripts.check, "pnpm lint && pnpm test && pnpm build");

const scriptTestFiles = listFiles("scripts")
  .map((path) => relative(".", path))
  .filter((path) => /(^|\/)(test-|verify-)[^/]+\.(ts|tsx|mjs|js)$/.test(path));

assert.deepEqual(scriptTestFiles, []);
assert.ok(existsSync("tests/run.ts"), "tests/run.ts should provide the root test command");

const packageScriptsUsingNpx = Object.entries(scripts)
  .filter(([, command]) => /\bnpx\b/.test(command))
  .map(([name, command]) => `${name}: ${command}`);

assert.deepEqual(packageScriptsUsingNpx, []);

const scriptShebangsUsingNpx = trackedFiles
  .filter((path) => path.endsWith(".ts"))
  .filter((path) => path.startsWith("scripts/"))
  .filter((path) => readFileSync(path, "utf8").startsWith("#!/usr/bin/env npx"));

assert.deepEqual(scriptShebangsUsingNpx, []);

const testFiles = listFiles("tests")
  .map((path) => relative(".", path))
  .filter((path) => path.endsWith(".test.ts") && path !== "tests/repo/test-suite-structure.test.ts");

assert.ok(testFiles.length >= 7, "migrated regression tests should live under tests/");

console.log("test suite structure checks passed");
