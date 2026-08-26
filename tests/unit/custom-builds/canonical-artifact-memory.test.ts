import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeCanonicalBuildArtifact } from "../../../lib/custom-builds/artifacts";

const MEMORY_CHILD = "MINEBENCH_CANONICAL_ARTIFACT_MEMORY_CHILD";

async function streamLargeArtifact() {
  const block = { x: 511, y: 511, z: 511, type: "oak_planks" };
  const artifact = await writeCanonicalBuildArtifact({
    version: "1.0",
    blocks: Array(1_500_000).fill(block),
  });
  try {
    assert.ok(artifact.byteSize > 60 * 1024 * 1024);
    assert.ok(artifact.storedByteSize < artifact.byteSize);
  } finally {
    await artifact.cleanup();
  }
}

async function main() {
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=96", require.resolve("tsx/cli"), fileURLToPath(import.meta.url)],
    {
      env: { ...process.env, [MEMORY_CHILD]: "1" },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, `canonical artifact exceeded its heap envelope\n${result.stderr}`);
  console.log("canonical artifact memory checks passed");
}

const run = process.env[MEMORY_CHILD] === "1" ? streamLargeArtifact() : main();
run.catch((error) => {
  console.error(error);
  process.exit(1);
});
