import assert from "node:assert/strict";
import { ATLAS } from "../../../lib/blocks/atlas";
import { getPalette } from "../../../lib/blocks/palettes";
import type { VoxelMeshPayload } from "../../../lib/voxel/mesh";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { decodeWorldMeshPayload, encodeWorldMeshPayload, getWorldMeshVersion } from "../../../lib/voxel/worldMesh";
import { WORLD_QUAD_WORDS, type WorldQuadBucketName } from "../../../lib/voxel/worldQuadData";
import { buildWorldRegionGreedyMeshPayload } from "../../../lib/voxel/worldRegionMesh";

const MAGIC = 0x4d425131;
const HEADER_BYTES = 8;
const BUCKETS = ["opaque", "cutout", "transparent", "water", "emissive"] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Metadata = {
  rendererVersion: string;
  anchor: [number, number, number];
  bounds: VoxelMeshPayload["bounds"];
  filteredBlockCount: number;
  bucketWordLengths: Record<WorldQuadBucketName, number>;
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function paddedLength(length: number): number {
  return length + ((4 - (length % 4)) % 4);
}

function fixturePayload(): VoxelMeshPayload {
  const payload = buildWorldRegionGreedyMeshPayload(
    packVoxelBlocks([
      { x: 0, y: 0, z: 0, type: "stone" },
      { x: 2, y: 0, z: 0, type: "oak_leaves" },
      { x: 4, y: 0, z: 0, type: "glass" },
      { x: 6, y: 0, z: 0, type: "water" },
      { x: 8, y: 0, z: 0, type: "glowstone" },
    ]),
    getPalette("simple").map((block) => block.id),
    { size: { x: 9, y: 1, z: 1 } },
  );
  assert.ok(payload.worldQuads);
  for (const bucket of BUCKETS) assert.ok(payload.worldQuads[bucket], `${bucket} fixture bucket is required`);
  return payload;
}

function metadataLength(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
}

function readMetadata(bytes: Uint8Array): Metadata {
  const length = metadataLength(bytes);
  return JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length))) as Metadata;
}

function writeMetadata(metadata: Metadata, body: Uint8Array): Uint8Array {
  const raw = encoder.encode(JSON.stringify(metadata));
  const metadataBytes = new Uint8Array(paddedLength(raw.length));
  metadataBytes.fill(0x20);
  metadataBytes.set(raw);
  const bytes = new Uint8Array(HEADER_BYTES + metadataBytes.length + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, false);
  view.setUint32(4, metadataBytes.length, false);
  bytes.set(metadataBytes, HEADER_BYTES);
  bytes.set(body, HEADER_BYTES + metadataBytes.length);
  return bytes;
}

function withMetadata(bytes: Uint8Array, mutate: (metadata: Metadata) => void): Uint8Array {
  const metadata = readMetadata(bytes);
  const body = bytes.slice(HEADER_BYTES + metadataLength(bytes));
  mutate(metadata);
  return writeMetadata(metadata, body);
}

function bucketWords(bytes: Uint8Array, bucket: WorldQuadBucketName): Uint32Array {
  const metadata = readMetadata(bytes);
  let byteOffset = HEADER_BYTES + metadataLength(bytes);
  for (const name of BUCKETS) {
    const wordLength = metadata.bucketWordLengths[name];
    if (name === bucket) return new Uint32Array(bytes.buffer, bytes.byteOffset + byteOffset, wordLength);
    byteOffset += wordLength * 4;
  }
  throw new Error(`Unknown bucket ${bucket}`);
}

function withBucketWord(
  bytes: Uint8Array,
  bucket: WorldQuadBucketName,
  wordOffset: number,
  mutate: (word: number) => number,
): Uint8Array {
  const copy = bytes.slice();
  const words = bucketWords(copy, bucket);
  words[wordOffset] = mutate(words[wordOffset]!) >>> 0;
  return copy;
}

function assertPayloadEqual(actual: VoxelMeshPayload, expected: VoxelMeshPayload): void {
  assert.equal(actual.opaque, null);
  assert.equal(actual.cutout, null);
  assert.equal(actual.transparent, null);
  assert.equal(actual.water, null);
  assert.equal(actual.emissive, null);
  assert.deepEqual(actual.bounds, expected.bounds);
  assert.equal(actual.filteredBlockCount, expected.filteredBlockCount);
  assert.deepEqual(actual.worldQuads?.anchor, expected.worldQuads?.anchor);
  for (const bucket of BUCKETS) {
    assert.deepEqual(Array.from(actual.worldQuads?.[bucket] ?? []), Array.from(expected.worldQuads?.[bucket] ?? []), bucket);
  }
}

function assertInvalid(bytes: Uint8Array, pattern = /Invalid world mesh payload/): void {
  assert.throws(() => decodeWorldMeshPayload(bytes), pattern);
}

async function versionIsStable() {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(ATLAS)));
  const expected = `v1-${hex(new Uint8Array(digest))}`;
  assert.equal(await getWorldMeshVersion(), expected);
  assert.equal(await getWorldMeshVersion(), expected);
}

function roundTripAndViews() {
  const payload = fixturePayload();
  const encoded = encodeWorldMeshPayload(payload);
  const decoded = decodeWorldMeshPayload(encoded);
  assertPayloadEqual(decoded, payload);
  assert.equal(decoded.worldQuads?.opaque?.buffer, encoded.buffer);

  const aligned = new Uint8Array(encoded.byteLength + 4);
  aligned.set(encoded, 4);
  const alignedDecoded = decodeWorldMeshPayload(aligned.subarray(4));
  assertPayloadEqual(alignedDecoded, payload);
  assert.equal(alignedDecoded.worldQuads?.opaque?.buffer, aligned.buffer);

  const unaligned = new Uint8Array(encoded.byteLength + 1);
  unaligned.set(encoded, 1);
  const unalignedDecoded = decodeWorldMeshPayload(unaligned.subarray(1));
  assertPayloadEqual(unalignedDecoded, payload);
  assert.notEqual(unalignedDecoded.worldQuads?.opaque?.buffer, unaligned.buffer);
}

function rejectsMalformedStructure() {
  const encoded = encodeWorldMeshPayload(fixturePayload());
  assertInvalid(encoded.slice(0, 4), /header is truncated/);
  const badMagic = encoded.slice();
  new DataView(badMagic.buffer).setUint32(0, 0, false);
  assertInvalid(badMagic, /magic is unsupported/);
  const badHeader = encoded.slice();
  new DataView(badHeader.buffer).setUint32(4, 3, false);
  assertInvalid(badHeader, /metadata header length is invalid/);
  const truncatedMetadata = encoded.slice();
  new DataView(truncatedMetadata.buffer).setUint32(4, encoded.byteLength, false);
  assertInvalid(truncatedMetadata, /metadata header is truncated/);
  assertInvalid(encoded.slice(0, -4), /bucket byte length mismatch/);

  assertInvalid(withMetadata(encoded, (metadata) => { metadata.bucketWordLengths.opaque = "4" as never; }), /opaque word length/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.bucketWordLengths.opaque += 1; }), /word length must align/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.anchor = [0.5, "0" as never, 0.5]; }), /anchor must be finite/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.bounds.radius = "1" as never; }), /bounds.radius must be positive/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.bounds.center = [0, 0, 0]; }), /bounds center is inconsistent/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.filteredBlockCount = -1; }), /filteredBlockCount/);
}

function rejectsCorruptQuads() {
  const encoded = encodeWorldMeshPayload(fixturePayload());
  assertInvalid(withBucketWord(encoded, "opaque", 0, (word) => word | 0x40000000), /unsupported coordinate bits/);
  assertInvalid(withBucketWord(encoded, "opaque", 1, (word) => (word & ~(0x7 << 20)) | (6 << 20)), /direction is invalid/);
  assertInvalid(withBucketWord(encoded, "opaque", 1, (word) => word & ~0x3ff), /extent must be nonzero/);
  assertInvalid(withBucketWord(encoded, "opaque", 3, (word) => word | 0x800), /unsupported color bits/);
  assertInvalid(withBucketWord(encoded, "opaque", 2, () => 0xffffffff), /atlas word is invalid/);
  assertInvalid(withBucketWord(encoded, "water", 2, () => 1), /water quad atlas word is invalid/);
  assertInvalid(withBucketWord(encoded, "opaque", 0, (word) => (word & ~0x3ff) | 1023), /exceeds declared bounds/);
  assert.equal(bucketWords(encoded, "opaque").length % WORLD_QUAD_WORDS, 0);
}

async function main() {
  await versionIsStable();
  roundTripAndViews();
  rejectsMalformedStructure();
  rejectsCorruptQuads();
  console.log("world mesh codec checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
