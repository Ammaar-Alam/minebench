import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function listTestFiles(path: string): string[] {
  if (!existsSync(path)) {
    throw new Error(`Test path does not exist: ${path}`);
  }

  const stats = statSync(path);
  if (stats.isFile()) {
    return path.endsWith(".test.ts") ? [path] : [];
  }

  return readdirSync(path)
    .flatMap((entry) => listTestFiles(join(path, entry)))
    .filter((entry) => entry.endsWith(".test.ts"));
}

const roots = process.argv.slice(2);
const testFiles = Array.from(new Set((roots.length > 0 ? roots : ["tests"]).flatMap(listTestFiles))).sort();

if (testFiles.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const failures: string[] = [];
const tsxCommand = process.platform === "win32" ? "tsx.cmd" : "tsx";

for (const testFile of testFiles) {
  const displayPath = relative(process.cwd(), testFile);
  console.log(`\n> ${displayPath}`);

  const result = spawnSync(tsxCommand, [testFile], {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    failures.push(displayPath);
    continue;
  }

  if (result.status !== 0) {
    failures.push(displayPath);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test file(s) failed:`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`\n${testFiles.length} test file(s) passed.`);
