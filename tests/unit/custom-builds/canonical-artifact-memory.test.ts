import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createPackedVoxelBlocks } from "../../../lib/voxel/packedBlocks";

const MEMORY_CHILD = "MINEBENCH_CANONICAL_ARTIFACT_MEMORY_CHILD";
const FAILURE_CHILD = "MINEBENCH_CANONICAL_ARTIFACT_FAILURE_CHILD";

async function streamLargeArtifact() {
  const { writeCanonicalBuildArtifact } = await import("../../../lib/custom-builds/artifacts");
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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for failed artifact stream")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function rejectFailedWriterWithoutHanging() {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs") as { createWriteStream: unknown };
  const originalCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = () => new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("forced artifact stream failure"));
    },
  });
  syncBuiltinESMExports();
  const { createVoxelBuildSourceArtifactWriter } = await import("../../../lib/voxel/canonicalArtifact");
  const writer = await createVoxelBuildSourceArtifactWriter();
  const failedWrite = (async () => {
    for (let index = 0; index < 256; index += 1) {
      await writer.write(new Uint8Array(64 * 1024).fill(index));
    }
    await writer.close();
  })();
  try {
    await assert.rejects(withTimeout(failedWrite, 1_000), /forced artifact stream failure|stream was destroyed/);
  } finally {
    await writer.abort().catch(() => undefined);
    await failedWrite.catch(() => undefined);
    fs.createWriteStream = originalCreateWriteStream;
    syncBuiltinESMExports();
  }
}

async function main() {
  const require = createRequire(import.meta.url);
  const failureResult = spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), fileURLToPath(import.meta.url)],
    {
      env: { ...process.env, [FAILURE_CHILD]: "1" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(
    failureResult.status,
    0,
    `canonical artifact failed writer did not reject cleanly\n${failureResult.stdout}\n${failureResult.stderr}`,
  );

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

const run = process.env[MEMORY_CHILD] === "1"
  ? streamLargeArtifact()
  : process.env[FAILURE_CHILD] === "1"
    ? rejectFailedWriterWithoutHanging()
    : main();
run.catch((error) => {
  console.error(error);
  process.exit(1);
});
