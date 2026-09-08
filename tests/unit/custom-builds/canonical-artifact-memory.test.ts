import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeCanonicalBuildArtifact } from "../../../lib/custom-builds/artifacts";
import { createPackedVoxelBlocks } from "../../../lib/voxel/packedBlocks";

const MEMORY_CHILD = "MINEBENCH_CANONICAL_ARTIFACT_MEMORY_CHILD";

async function streamLargeArtifact() {
  const packed = createPackedVoxelBlocks(1_500_000);
  packed.count = 1_500_000;
  packed.typeNames.push("oak_planks");
  for (let index = 0; index < packed.count; index += 1) {
    packed.positions[index * 3] = index >> 18;
    packed.positions[index * 3 + 1] = (index >> 9) & 511;
    packed.positions[index * 3 + 2] = index & 511;
  }
  const artifact = await writeCanonicalBuildArtifact({
    version: "1.0",
    blocks: [],
    packed,
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
