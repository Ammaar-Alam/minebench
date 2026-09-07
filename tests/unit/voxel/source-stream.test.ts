import assert from "node:assert/strict";
import { parseVoxelBuildStream } from "../../../lib/voxel/sourceStream";
import { unpackVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { parseVoxelBuildSpec } from "../../../lib/voxel/validate";

async function* chunks(text: string, width: number) {
  const bytes = new TextEncoder().encode(text);
  for (let index = 0; index < bytes.length; index += width) yield bytes.subarray(index, index + width);
}

async function main() {
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
  for (const width of [1, 7, 4096]) {
    const parsed = await parseVoxelBuildStream(chunks(JSON.stringify(source, null, 2), width));
    assert.deepEqual(unpackVoxelBlocks(parsed.packed!), normalized.value.blocks);
    assert.deepEqual(parsed.lines, normalized.value.lines);
    assert.deepEqual(parsed.boxes, [{ ...normalized.value.boxes![0], x2: 3 }]);
    assert.deepEqual(parsed.blocks, []);
    assert.equal("metadata" in parsed, false);
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
  console.log("streamed build source checks passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
