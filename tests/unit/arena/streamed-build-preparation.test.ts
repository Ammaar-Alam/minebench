import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { prepareArenaBuild, prepareArenaBuildFromBuild, type ArenaBuildSource } from "../../../lib/arena/buildArtifacts";
import { encodeBinaryArtifact } from "../../../lib/arena/binaryArtifact";
import { encodeArenaBuildStreamEvent, gzipArenaBuildStreamEvents, iterateArenaBuildStreamEvents } from "../../../lib/arena/buildStream";
import { getPalette } from "../../../lib/blocks/palettes";
import { createVoxelMeshFacts, encodeVoxelMeshFacts } from "../../../lib/voxel/meshFacts";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { validateVoxelBuild } from "../../../lib/voxel/validate";

// a hollow-ish globe with boxes, lines, duplicates, and an unknown type
const blocks: Array<{ x: number; y: number; z: number; type: string }> = [];
const types = ["stone", "grass", "water", "sand", "oak_planks"];
for (let x = -20; x <= 20; x++) for (let y = -20; y <= 20; y++) for (let z = -20; z <= 20; z++) {
  const d = x * x + y * y + z * z;
  if (d <= 400 && d >= 250) blocks.push({ x: x + 128, y: y + 128, z: z + 128, type: types[(((x + y * 3 + z * 7) % 5) + 5) % 5]! });
}
blocks.push({ ...blocks[0]!, type: "sand" }, { x: 1, y: 1, z: 1, type: "not_a_block" });
const payload = {
  version: "1.0",
  boxes: [{ x1: 10, y1: 0, z1: 10, x2: 14, y2: 3, z2: 14, type: "stone" }],
  lines: [{ from: { x: 0, y: 5, z: 0 }, to: { x: 30, y: 5, z: 0 }, type: "oak_planks" }],
  blocks,
};

const dir = mkdtempSync(path.join(process.cwd(), ".streamed-build-test-"));
const encode = (prepared: Awaited<ReturnType<typeof prepareArenaBuild>>) => {
  const full = prepared.fullBuild;
  const packed = full.packed ?? packVoxelBlocks(full.blocks);
  return {
    checksum: prepared.checksum,
    hints: prepared.hints,
    binary: encodeBinaryArtifact({ buildId: prepared.buildId, variant: "full", checksum: prepared.checksum, serverValidated: true, buildLoadHints: prepared.hints, version: full.version } as never, packed, prepared.checksum),
    facts: encodeVoxelMeshFacts(createVoxelMeshFacts(packed)),
    stream: Buffer.concat([...iterateArenaBuildStreamEvents({ buildId: prepared.buildId, variant: "full", checksum: prepared.checksum, build: full, buildLoadHints: prepared.hints, source: "artifact", serverValidated: true, includePad: true, durationMs: 0 } as never)].map(encodeArenaBuildStreamEvent)),
  };
};

async function main() {
  try {
    const file = path.join(dir, "build.json.gz");
    writeFileSync(file, gzipSync(JSON.stringify(payload)));
    const source: ArenaBuildSource = {
      id: "streamed", gridSize: 256, palette: "simple", blockCount: blocks.length,
      voxelByteSize: null, voxelCompressedByteSize: null, voxelSha256: "streamed-checksum", voxelData: null,
      voxelStorageBucket: "__local_fs__", voxelStoragePath: path.relative(process.cwd(), file), voxelStorageEncoding: "gzip",
    };
    const streamed = await prepareArenaBuild(source);
    assert.ok(streamed.fullBuild.packed, "stored builds prepare as packed blocks");

    const validated = validateVoxelBuild(payload, { gridSize: 256, palette: getPalette("simple"), maxBlocks: Number.MAX_SAFE_INTEGER });
    assert.ok(validated.ok);
    const objects = prepareArenaBuildFromBuild(source, validated.value.build, { payloadEstimatedBytes: Buffer.byteLength(JSON.stringify(payload)) });

    const a = encode(streamed);
    const b = encode(objects);
    assert.equal(a.checksum, b.checksum);
    assert.equal(a.hints.fullBlockCount, b.hints.fullBlockCount);
    assert.equal(a.hints.previewBlockCount, b.hints.previewBlockCount);
    assert.deepEqual(Buffer.from(a.binary), Buffer.from(b.binary), "binary artifact matches the object path");
    assert.deepEqual(Buffer.from(a.facts), Buffer.from(b.facts), "mesh facts match the object path");
    assert.deepEqual(a.stream, b.stream, "stream events match the object path");

    const events = [...iterateArenaBuildStreamEvents({ buildId: "streamed", variant: "full", checksum: streamed.checksum, build: streamed.fullBuild, buildLoadHints: streamed.hints, source: "artifact", serverValidated: true, includePad: true, durationMs: 0 } as never)];
    assert.deepEqual(gunzipSync(await gzipArenaBuildStreamEvents(events)), a.stream, "incremental gzip round-trips the stream");
    console.log("streamed build preparation checks passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MEMORY_CHILD = "MINEBENCH_STREAMED_PREPARATION_MEMORY_CHILD";

// a million fully visible blocks through every worker artifact inside a heap the object path cannot fit
async function prepareUnderHeapEnvelope() {
  const checker = mkdtempSync(path.join(process.cwd(), ".streamed-build-memory-"));
  try {
    const parts: string[] = [];
    let count = 0;
    for (let x = 0; x < 128 && count < 1_000_000; x++) for (let y = 0; y < 128 && count < 1_000_000; y++) for (let z = 0; z < 256 && count < 1_000_000; z++) {
      if ((x + y + z) & 1) continue;
      parts.push(`{"x":${x},"y":${y},"z":${z},"type":"${types[(x + z) % 5]}"}`);
      count++;
    }
    const file = path.join(checker, "checker.json.gz");
    writeFileSync(file, gzipSync(`{"version":"1.0","blocks":[${parts.join(",")}]}`));
    parts.length = 0;
    const prepared = await prepareArenaBuild({
      id: "checker", gridSize: 256, palette: "simple", blockCount: count,
      voxelByteSize: null, voxelCompressedByteSize: null, voxelSha256: "checker-checksum", voxelData: null,
      voxelStorageBucket: "__local_fs__", voxelStoragePath: path.relative(process.cwd(), file), voxelStorageEncoding: "gzip",
    });
    const full = prepared.fullBuild;
    gzipSync(encodeBinaryArtifact({ buildId: "checker", variant: "full", checksum: prepared.checksum, serverValidated: true, buildLoadHints: prepared.hints, version: full.version } as never, full.packed!, prepared.checksum));
    gzipSync(encodeVoxelMeshFacts(createVoxelMeshFacts(full.packed!)));
    await gzipArenaBuildStreamEvents(iterateArenaBuildStreamEvents({ buildId: "checker", variant: "full", checksum: prepared.checksum, build: full, buildLoadHints: prepared.hints, source: "artifact", serverValidated: true, includePad: true, durationMs: 0 } as never));
    console.log(`prepared ${prepared.hints.fullBlockCount} visible blocks under the heap envelope`);
  } finally {
    rmSync(checker, { recursive: true, force: true });
  }
}

async function run() {
  if (process.env[MEMORY_CHILD] === "1") return prepareUnderHeapEnvelope();
  await main();
  const require = createRequire(import.meta.url);
  const child = spawnSync(
    process.execPath,
    ["--max-old-space-size=128", require.resolve("tsx/cli"), fileURLToPath(import.meta.url)],
    { env: { ...process.env, [MEMORY_CHILD]: "1" }, encoding: "utf8" },
  );
  assert.equal(child.status, 0, `arena preparation exceeded its heap envelope\n${child.stderr}`);
  console.log(child.stdout.trim());
}

run().catch((error) => { console.error(error); process.exit(1); });
