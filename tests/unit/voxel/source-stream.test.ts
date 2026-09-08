import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getPalette } from "../../../lib/blocks/palettes";
import { voxelBuildSourceJsonChunks } from "../../../lib/voxel/canonicalArtifact";
import { parseVoxelBuildStream } from "../../../lib/voxel/sourceStream";
import { unpackVoxelBlocks, unpackVoxelBoxes } from "../../../lib/voxel/packedBlocks";
import { parseVoxelBuildSpec } from "../../../lib/voxel/validate";
import { evaluateVoxelWorldRegions, type VoxelWorldRegion } from "../../../lib/voxel/worldRegions";

const BOX_MEMORY_CHILD = "MINEBENCH_SOURCE_STREAM_BOX_MEMORY_CHILD";

async function* chunks(text: string, width: number) {
  const bytes = new TextEncoder().encode(text);
  for (let index = 0; index < bytes.length; index += width) yield bytes.subarray(index, index + width);
}

function expandRegions(regions: Iterable<VoxelWorldRegion>, palette: ReturnType<typeof getPalette>): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const region of regions) {
    if (region.kind === "uniform") {
      for (let z = region.origin.z; z < region.origin.z + region.size.z; z += 1) {
        for (let y = region.origin.y; y < region.origin.y + region.size.y; y += 1) {
          for (let x = region.origin.x; x < region.origin.x + region.size.x; x += 1) {
            blocks.set(`${x},${y},${z}`, region.type);
          }
        }
      }
      continue;
    }
    const sx = region.size.x;
    const strideZ = sx * region.size.y;
    for (let index = 0; index < region.materialIndexes.length; index += 1) {
      const material = region.materialIndexes[index]!;
      if (material === 0) continue;
      blocks.set(
        `${region.origin.x + (index % sx)},${region.origin.y + (Math.floor(index / sx) % region.size.y)},${region.origin.z + Math.floor(index / strideZ)}`,
        palette[material - 1]!.id,
      );
    }
  }
  return blocks;
}

async function* manyBoxSource(count: number): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  yield encoder.encode('{"version":"1.0","boxes":[');
  for (let index = 0; index < count; index += 1) {
    const x = index & 63;
    const z = (index >> 6) & 63;
    const type = index % 2 === 0 ? "stone" : "glass";
    yield encoder.encode(`${index === 0 ? "" : ","}{"x1":${x},"y1":0,"z1":${z},"x2":${x},"y2":0,"z2":${z},"type":"${type}"}`);
  }
  yield encoder.encode('],"lines":[{"from":{"x":0,"y":0,"z":0},"to":{"x":63,"y":0,"z":0},"type":"dirt"}],"blocks":[{"x":0,"y":0,"z":0,"type":"gold_block"},{"x":63,"y":0,"z":63,"type":"oak_log"}]}');
}

function lastBoxType(count: number, x: number, z: number): string {
  const first = x + z * 64;
  const last = first + Math.floor((count - 1 - first) / 4096) * 4096;
  return last % 2 === 0 ? "stone" : "glass";
}

async function assertLargeBoxStreamDoesNotRetainObjects() {
  const boxCount = 1_000_000;
  const parsed = await parseVoxelBuildStream(manyBoxSource(boxCount));
  assert.ok((parsed.boxes?.length ?? 0) < boxCount / 100, "stream parser must not retain one JS object per box");
  assert.equal((parsed as { packedBoxes?: { count: number } }).packedBoxes?.count, boxCount);

  const palette = getPalette("simple");
  const evaluated = evaluateVoxelWorldRegions(parsed, { gridSize: 64, palette });
  if (!evaluated.ok) throw new Error(evaluated.error);
  const blocks = expandRegions(evaluated.regions, palette);
  assert.equal(blocks.size, 4096);
  assert.equal(blocks.get("0,0,0"), "gold_block");
  assert.equal(blocks.get("7,0,0"), "dirt");
  assert.equal(blocks.get("63,0,63"), "oak_log");
  assert.equal(blocks.get("10,0,10"), lastBoxType(boxCount, 10, 10));
}

async function main() {
  if (process.env[BOX_MEMORY_CHILD] === "1") {
    await assertLargeBoxStreamDoesNotRetainObjects();
    return;
  }

  const source = {
    version: "1.0",
    metadata: { label: 'ignored " Unicode 日', flags: [true, false, null], nested: {} },
    enabled: true,
    ratio: -1.25e3,
    note: "ignored",
    extra: null,
    boxes: [
      { x1: 0, y1: 0, z1: 0, x2: 1, y2: 0, z2: 0, type: "stone", extra: true },
      { x1: 2, y1: 0, z1: 0, x2: 3, y2: 0, z2: 0, type: "stone" },
    ],
    lines: [{ from: { x: 0, y: 0, z: 0, extra: true }, to: { x: 4, y: 2, z: 1, extra: true }, type: "glass", extra: true }],
    blocks: [{ x: 0, y: 0, z: 0, type: "stone", extra: true }, { x: 8191, y: 2, z: 40, type: 'escaped " Unicode 日' }],
  };
  const normalized = parseVoxelBuildSpec(source);
  assert.equal(normalized.ok, true);
  const expectedSourceJson = '{"version":"1.0","boxes":[{"x1":0,"y1":0,"z1":0,"x2":3,"y2":0,"z2":0,"type":"stone"}],"lines":[{"from":{"x":0,"y":0,"z":0},"to":{"x":4,"y":2,"z":1},"type":"glass"}],"blocks":[{"x":0,"y":0,"z":0,"type":"stone"},{"x":8191,"y":2,"z":40,"type":"escaped \\" Unicode 日"}]}';
  const boundarySource = '{"version":"1.0","boxes":[{"x1":32767,"y1":0,"z1":0,"x2":32767,"y2":0,"z2":0,"type":"stone"},{"x1":32768,"y1":0,"z1":0,"x2":32768,"y2":0,"z2":0,"type":"stone"}],"blocks":[]}';
  const boundary = await parseVoxelBuildStream(chunks(boundarySource, 13));
  const boundaryJson = Buffer.concat(Array.from(voxelBuildSourceJsonChunks(boundary), (chunk) => Buffer.from(chunk))).toString("utf8");
  assert.equal(boundaryJson, '{"version":"1.0","boxes":[{"x1":32767,"y1":0,"z1":0,"x2":32768,"y2":0,"z2":0,"type":"stone"}],"blocks":[]}');

  for (const width of [1, 7, 4096]) {
    const parsed = await parseVoxelBuildStream(chunks(JSON.stringify(source, null, 2), width));
    assert.deepEqual(unpackVoxelBlocks(parsed.packed!), normalized.value.blocks);
    assert.deepEqual(parsed.lines, normalized.value.lines);
    assert.deepEqual(unpackVoxelBoxes(parsed.packedBoxes!), [{ ...normalized.value.boxes![0], x2: 3 }]);
    assert.deepEqual(parsed.blocks, []);
    assert.deepEqual(parsed.boxes, []);
    assert.equal("metadata" in parsed, false);
    const sourceJson = Buffer.concat(Array.from(voxelBuildSourceJsonChunks(parsed), (chunk) => Buffer.from(chunk))).toString("utf8");
    assert.equal(sourceJson, expectedSourceJson);
    assert.deepEqual(JSON.parse(sourceJson), {
      version: "1.0",
      boxes: [{ ...normalized.value.boxes![0], x2: 3 }],
      lines: normalized.value.lines,
      blocks: normalized.value.blocks,
    });
  }
  for (const [field, entry] of [
    ["blocks", { x: "0", y: 0, z: 0, type: "stone" }],
    ["blocks", { x: 0, y: 0.5, z: 0, type: "stone" }],
    ["blocks", { x: 0, y: 0, z: null, type: "stone" }],
    ["blocks", { x: 0, y: 0, z: 0, type: "" }],
    ["blocks", { x: 0, y: 0, z: 0, type: 1 }],
    ["boxes", { x1: 0, y1: 0, z1: 0, x2: 1, y2: 0, type: "stone" }],
    ["boxes", { x1: 0.5, y1: 0, z1: 0, x2: 1, y2: 0, z2: 0, type: "stone" }],
    ["boxes", { x1: 0, y1: 0, z1: 0, x2: 1, y2: 0, z2: 0, type: "" }],
    ["lines", { from: null, to: { x: 1, y: 0, z: 0 }, type: "stone" }],
    ["lines", { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: "0" }, type: "stone" }],
    ["lines", { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, type: "" }],
  ] as const) {
    const invalid = { version: "1.0", blocks: [], [field]: [entry] };
    assert.equal(parseVoxelBuildSpec(invalid).ok, false);
    await assert.rejects(parseVoxelBuildStream(chunks(JSON.stringify(invalid), 7)));
  }
  const repeatedBlocks = Array.from({ length: 4100 }, (_, index) => ({
    x: index % 8, y: 0, z: 0, type: index % 2 === 0 ? "stone" : "glass",
  }));
  const repeated = await parseVoxelBuildStream(chunks(JSON.stringify({ version: "1.0", blocks: repeatedBlocks }), 4096));
  assert.deepEqual(unpackVoxelBlocks(repeated.packed!), repeatedBlocks, "batch reuse must preserve the complete paint order");
  for (const text of [
    '\u00a0{"version":"1.0","blocks":[]}',
    '{"version":"1.0","blocks":[],"extra":truex}',
    '{"version":"1.0","blocks":[],"extra":[1,]}',
    '{"version":"1.0","blocks":[}',
    '{"version":"1.0","blocks":[],}',
    '{"version":"1.0","blocks":[],"blocks":[]}',
    '{"version":"1.0","blocks":[]} garbage',
    '{"version":"1.0","blocks":[{"x":32768,"y":0,"z":0,"type":"stone"}]}',
    '{"version":"1.0","blocks":[{"x":0.5,"y":0,"z":0,"type":"stone"}]}',
    '{"version":"1.0","blocks":[]',
  ]) await assert.rejects(parseVoxelBuildStream(chunks(text, 3)));
  const bounded = JSON.stringify({ version: "1.0", blocks: repeatedBlocks });
  await assert.rejects(parseVoxelBuildStream(chunks(bounded, 17), { maxBlocks: 4099 }), /block count/);
  const exact = await parseVoxelBuildStream(chunks(bounded, 17), { maxBlocks: 4100 });
  assert.equal(exact.packed?.count, 4100);

  const require = createRequire(import.meta.url);
  const memoryResult = spawnSync(
    process.execPath,
    ["--max-old-space-size=128", require.resolve("tsx/cli"), fileURLToPath(import.meta.url)],
    { env: { ...process.env, [BOX_MEMORY_CHILD]: "1" }, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(
    memoryResult.status,
    0,
    `streamed box import retained too much heap or changed paint order\n${memoryResult.stdout}\n${memoryResult.stderr}`,
  );
  console.log("streamed build source checks passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
