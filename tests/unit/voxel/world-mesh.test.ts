import assert from "node:assert/strict";
import { ATLAS } from "../../../lib/blocks/atlas";
import { getPalette } from "../../../lib/blocks/palettes";
import type { VoxelMeshPayload } from "../../../lib/voxel/mesh";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import {
  decodeWorldMeshPayload,
  encodeWorldMeshPayload,
  getWorldMeshVersion,
  isWorldMeshVersionSupported,
} from "../../../lib/voxel/worldMesh";
import { WORLD_QUAD_WORDS, type WorldQuadBucketName, type WorldQuadPayload } from "../../../lib/voxel/worldQuadData";
import { buildWorldRegionGreedyMeshPayload } from "../../../lib/voxel/worldRegionMesh";
import type { WorldSurfaceTilePage } from "../../../lib/voxel/worldSurfaceTiles";

const MAGIC_V1 = 0x4d425131;
const MAGIC_V2 = 0x4d425132;
const HEADER_BYTES = 8;
const SURFACE_WIDTH = 2048;
const BUCKETS = ["opaque", "cutout", "transparent", "water", "emissive"] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type SurfacePageMetadata = {
  quadWordLength: number;
  texelWordLength: number;
  width: number;
  height: number;
};
type TransparentDepthMetadata = {
  quadWordLength: number;
  surfacePages: SurfacePageMetadata[];
};

type Metadata = {
  rendererVersion: string;
  anchor: [number, number, number];
  bounds: VoxelMeshPayload["bounds"];
  filteredBlockCount: number;
  bucketWordLengths: Record<WorldQuadBucketName, number>;
  surfacePages?: SurfacePageMetadata[];
  transparentDepth?: TransparentDepthMetadata;
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function paddedLength(length: number): number {
  return length + ((4 - (length % 4)) % 4);
}

function payloadMagic(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
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

function atlasOriginSet(): Set<number> {
  const words = new Set<number>();
  for (const entry of Object.values(ATLAS.keys)) {
    const u = entry.x;
    const v = ATLAS.atlasHeight - entry.y - entry.h;
    if (Number.isInteger(u) && Number.isInteger(v) && u >= 0 && v >= 0 && u <= 1023 && v <= 1023) {
      words.add((u | (v << 16)) >>> 0);
    }
  }
  return words;
}

function firstAtlasOrigin(): [number, number] {
  for (const entry of Object.values(ATLAS.keys)) {
    const u = entry.x;
    const v = ATLAS.atlasHeight - entry.y - entry.h;
    if (Number.isInteger(u) && Number.isInteger(v) && u >= 0 && v >= 0 && u <= 1023 && v <= 1023) {
      return [u, v];
    }
  }
  assert.fail("fixture requires at least one atlas origin");
}

function invalidAtlasCellWord(): number {
  const valid = atlasOriginSet();
  for (let v = 0; v <= 1023; v += 1) {
    for (let u = 0; u <= 1023; u += 1) {
      if (!valid.has((u | (v << 16)) >>> 0)) return surfaceCellWord(u, v, 0);
    }
  }
  assert.fail("fixture requires at least one unused atlas origin");
}

function surfaceCellWord(atlasU: number, atlasV: number, flags: number): number {
  return (atlasU | (atlasV << 10) | (flags << 20)) >>> 0;
}

function transparentQuadFixture(): Uint32Array {
  const [atlasU, atlasV] = firstAtlasOrigin();
  return new Uint32Array([
    0,
    1 | (1 << 10),
    (atlasU | (atlasV << 16)) >>> 0,
    0,
  ]);
}

function surfaceFixturePage(): WorldSurfaceTilePage {
  const [atlasU, atlasV] = firstAtlasOrigin();
  const texels = new Uint32Array(SURFACE_WIDTH);
  texels[0] = 0x1;
  texels[1] = (1 << 16) | 0x2;
  texels[2] = surfaceCellWord(atlasU, atlasV, 2047);
  texels[3] = surfaceCellWord(atlasU, atlasV, 5);
  texels[4] = 0x1;
  texels[5] = surfaceCellWord(atlasU, atlasV, 7);
  return {
    quads: new Uint32Array([
      0,
      2 | (2 << 10),
      0,
      0,
      1,
      1 | (1 << 10) | (2 << 20),
      4,
      0,
    ]),
    texels,
    width: SURFACE_WIDTH,
    height: 1,
  };
}

function clonePage(page: WorldSurfaceTilePage): WorldSurfaceTilePage {
  return { quads: page.quads.slice(), texels: page.texels.slice(), width: page.width, height: page.height };
}

function surfacePageMetadata(page: WorldSurfaceTilePage): SurfacePageMetadata {
  return {
    quadWordLength: page.quads.length,
    texelWordLength: page.texels.length,
    width: page.width,
    height: page.height,
  };
}

function surfacePayload(surfaces?: WorldSurfaceTilePage[]): VoxelMeshPayload {
  const worldQuads: WorldQuadPayload = {
    anchor: [0, 0, 0],
    opaque: null,
    cutout: null,
    transparent: null,
    water: null,
    emissive: null,
  };
  if (surfaces) worldQuads.surfaces = surfaces;
  return {
    opaque: null,
    cutout: null,
    transparent: null,
    water: null,
    emissive: null,
    bounds: {
      min: [0, 0, 0],
      max: [2, 2, 2],
      center: [1, 1, 1],
      radius: Math.sqrt(3),
    },
    filteredBlockCount: surfaces?.length ? 3 : 0,
    worldQuads,
  };
}

function surfacePagesBody(pages: readonly WorldSurfaceTilePage[]): Uint8Array {
  const byteLength = pages.reduce((sum, page) => sum + page.quads.byteLength + page.texels.byteLength, 0);
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const page of pages) {
    body.set(new Uint8Array(page.quads.buffer, page.quads.byteOffset, page.quads.byteLength), offset);
    offset += page.quads.byteLength;
    body.set(new Uint8Array(page.texels.buffer, page.texels.byteOffset, page.texels.byteLength), offset);
    offset += page.texels.byteLength;
  }
  return body;
}

function metadataLength(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
}

function readMetadata(bytes: Uint8Array): Metadata {
  const length = metadataLength(bytes);
  return JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length))) as Metadata;
}

function writeMetadata(metadata: Metadata, body: Uint8Array, magic: number): Uint8Array {
  const raw = encoder.encode(JSON.stringify(metadata));
  const metadataBytes = new Uint8Array(paddedLength(raw.length));
  metadataBytes.fill(0x20);
  metadataBytes.set(raw);
  const bytes = new Uint8Array(HEADER_BYTES + metadataBytes.length + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, false);
  view.setUint32(4, metadataBytes.length, false);
  bytes.set(metadataBytes, HEADER_BYTES);
  bytes.set(body, HEADER_BYTES + metadataBytes.length);
  return bytes;
}

function withMetadata(bytes: Uint8Array, mutate: (metadata: Metadata) => void): Uint8Array {
  const metadata = readMetadata(bytes);
  const body = bytes.slice(HEADER_BYTES + metadataLength(bytes));
  mutate(metadata);
  return writeMetadata(metadata, body, payloadMagic(bytes));
}

function bucketBody(payload: VoxelMeshPayload): Uint8Array {
  assert.ok(payload.worldQuads);
  const byteLength = BUCKETS.reduce((sum, bucket) => sum + (payload.worldQuads![bucket]?.byteLength ?? 0), 0);
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const bucket of BUCKETS) {
    const words = payload.worldQuads[bucket];
    if (!words) continue;
    body.set(new Uint8Array(words.buffer, words.byteOffset, words.byteLength), offset);
    offset += words.byteLength;
  }
  return body;
}

function encodeLegacyWorldMeshPayload(payload: VoxelMeshPayload): Uint8Array {
  assert.ok(payload.worldQuads);
  return writeMetadata({
    rendererVersion: "v1",
    anchor: payload.worldQuads.anchor,
    bounds: payload.bounds,
    filteredBlockCount: payload.filteredBlockCount,
    bucketWordLengths: Object.fromEntries(BUCKETS.map((bucket) => [
      bucket,
      payload.worldQuads![bucket]?.length ?? 0,
    ])) as Record<WorldQuadBucketName, number>,
  }, bucketBody(payload), MAGIC_V1);
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

function surfaceOffsets(
  bytes: Uint8Array,
  pageIndex: number,
  source: "surfacePages" | "transparentDepth" = "surfacePages",
): { quadOffset: number; texelOffset: number; metadata: SurfacePageMetadata } {
  const metadata = readMetadata(bytes);
  let byteOffset = HEADER_BYTES + metadataLength(bytes);
  for (const bucket of BUCKETS) byteOffset += metadata.bucketWordLengths[bucket] * 4;
  if (source === "transparentDepth") {
    assert.ok(metadata.transparentDepth);
    for (const page of metadata.surfacePages ?? []) byteOffset += (page.quadWordLength + page.texelWordLength) * 4;
    byteOffset += metadata.transparentDepth.quadWordLength * 4;
  }
  const pages = source === "transparentDepth" ? metadata.transparentDepth!.surfacePages : metadata.surfacePages;
  assert.ok(pages);
  for (let index = 0; index < pageIndex; index += 1) {
    const page = pages[index]!;
    byteOffset += (page.quadWordLength + page.texelWordLength) * 4;
  }
  const page = pages[pageIndex]!;
  return { quadOffset: byteOffset, texelOffset: byteOffset + page.quadWordLength * 4, metadata: page };
}

function transparentDepthQuadWords(bytes: Uint8Array): Uint32Array {
  const metadata = readMetadata(bytes);
  assert.ok(metadata.transparentDepth);
  let byteOffset = HEADER_BYTES + metadataLength(bytes);
  for (const bucket of BUCKETS) byteOffset += metadata.bucketWordLengths[bucket] * 4;
  for (const page of metadata.surfacePages ?? []) byteOffset += (page.quadWordLength + page.texelWordLength) * 4;
  return new Uint32Array(bytes.buffer, bytes.byteOffset + byteOffset, metadata.transparentDepth.quadWordLength);
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

function withSurfaceQuadWord(
  bytes: Uint8Array,
  pageIndex: number,
  wordOffset: number,
  mutate: (word: number) => number,
  source: "surfacePages" | "transparentDepth" = "surfacePages",
): Uint8Array {
  const copy = bytes.slice();
  const offsets = surfaceOffsets(copy, pageIndex, source);
  const words = new Uint32Array(copy.buffer, copy.byteOffset + offsets.quadOffset, offsets.metadata.quadWordLength);
  words[wordOffset] = mutate(words[wordOffset]!) >>> 0;
  return copy;
}

function withSurfaceTexelWord(
  bytes: Uint8Array,
  pageIndex: number,
  wordOffset: number,
  mutate: (word: number) => number,
  source: "surfacePages" | "transparentDepth" = "surfacePages",
): Uint8Array {
  const copy = bytes.slice();
  const offsets = surfaceOffsets(copy, pageIndex, source);
  const words = new Uint32Array(copy.buffer, copy.byteOffset + offsets.texelOffset, offsets.metadata.texelWordLength);
  words[wordOffset] = mutate(words[wordOffset]!) >>> 0;
  return copy;
}

function withTransparentDepthQuadWord(bytes: Uint8Array, wordOffset: number, mutate: (word: number) => number): Uint8Array {
  const copy = bytes.slice();
  const words = transparentDepthQuadWords(copy);
  words[wordOffset] = mutate(words[wordOffset]!) >>> 0;
  return copy;
}

function assertSurfacePagesEqual(actual: readonly WorldSurfaceTilePage[], expected: readonly WorldSurfaceTilePage[]): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index]?.width, expected[index]?.width);
    assert.equal(actual[index]?.height, expected[index]?.height);
    assert.deepEqual(Array.from(actual[index]?.quads ?? []), Array.from(expected[index]?.quads ?? []));
    assert.deepEqual(Array.from(actual[index]?.texels ?? []), Array.from(expected[index]?.texels ?? []));
  }
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
  assertSurfacePagesEqual(actual.worldQuads?.surfaces ?? [], expected.worldQuads?.surfaces ?? []);
  const actualDepth = actual.worldQuads?.transparentDepth;
  const expectedDepth = expected.worldQuads?.transparentDepth;
  if (!expectedDepth) {
    assert.equal(actualDepth, undefined);
  } else {
    assert.ok(actualDepth);
    assert.equal(actualDepth.quads === null, expectedDepth.quads === null);
    assert.deepEqual(Array.from(actualDepth.quads ?? []), Array.from(expectedDepth.quads ?? []));
    assertSurfacePagesEqual(actualDepth.surfaces, expectedDepth.surfaces);
  }
}

function assertInvalid(bytes: Uint8Array, pattern = /Invalid world mesh payload/): void {
  assert.throws(() => decodeWorldMeshPayload(bytes), pattern);
}

async function versionIsStable() {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(ATLAS)));
  const atlasHash = hex(new Uint8Array(digest));
  const current = `v2-${atlasHash}`;
  const legacy = `v1-${atlasHash}`;
  assert.equal(await getWorldMeshVersion(), current);
  assert.equal(await getWorldMeshVersion(), current);
  assert.equal(await isWorldMeshVersionSupported(current), true);
  assert.equal(await isWorldMeshVersionSupported(legacy), true);
  assert.equal(await isWorldMeshVersionSupported(`v3-${atlasHash}`), false);
  assert.equal(await isWorldMeshVersionSupported("v2-not-the-current-atlas"), false);
}

function roundTripBucketsAndViews() {
  const payload = fixturePayload();
  const encoded = encodeWorldMeshPayload(payload);
  const metadata = readMetadata(encoded);
  assert.equal(payloadMagic(encoded), MAGIC_V2);
  assert.equal(metadata.rendererVersion, "v2");
  assert.deepEqual(metadata.surfacePages, []);
  assert.equal(metadata.transparentDepth, undefined);
  const decoded = decodeWorldMeshPayload(encoded);
  assertPayloadEqual(decoded, payload);
  assert.equal(decoded.worldQuads?.transparentDepth, undefined);
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

  assertPayloadEqual(decodeWorldMeshPayload(encodeWorldMeshPayload(surfacePayload())), surfacePayload());
  assertPayloadEqual(decodeWorldMeshPayload(encodeWorldMeshPayload(surfacePayload([]))), surfacePayload([]));
}

function roundTripsSurfacePagesAndViews() {
  const page = surfaceFixturePage();
  const payload = surfacePayload([page]);
  const encoded = encodeWorldMeshPayload(payload);
  const metadata = readMetadata(encoded);
  assert.deepEqual(metadata.surfacePages, [{
    ...surfacePageMetadata(page),
  }]);
  assert.equal(metadata.transparentDepth, undefined);

  const decoded = decodeWorldMeshPayload(encoded);
  assertPayloadEqual(decoded, payload);
  assert.equal(decoded.worldQuads?.surfaces?.[0]?.quads.buffer, encoded.buffer);
  assert.equal(decoded.worldQuads?.surfaces?.[0]?.texels.buffer, encoded.buffer);

  const aligned = new Uint8Array(encoded.byteLength + 4);
  aligned.set(encoded, 4);
  const alignedDecoded = decodeWorldMeshPayload(aligned.subarray(4));
  assertPayloadEqual(alignedDecoded, payload);
  assert.equal(alignedDecoded.worldQuads?.surfaces?.[0]?.texels.buffer, aligned.buffer);

  const unaligned = new Uint8Array(encoded.byteLength + 1);
  unaligned.set(encoded, 1);
  const unalignedDecoded = decodeWorldMeshPayload(unaligned.subarray(1));
  assertPayloadEqual(unalignedDecoded, payload);
  assert.notEqual(unalignedDecoded.worldQuads?.surfaces?.[0]?.texels.buffer, unaligned.buffer);
}

function roundTripsTransparentDepth() {
  const payload = surfacePayload();
  assert.ok(payload.worldQuads);
  payload.worldQuads.transparent = transparentQuadFixture();
  const transparentBefore = Array.from(payload.worldQuads.transparent);
  const page = surfaceFixturePage();
  const depthQuads = payload.worldQuads.transparent.slice(0, WORLD_QUAD_WORDS);
  payload.worldQuads.transparentDepth = { quads: depthQuads, surfaces: [page] };
  const encoded = encodeWorldMeshPayload(payload);
  assert.deepEqual(readMetadata(encoded).transparentDepth, {
    quadWordLength: depthQuads.length,
    surfacePages: [surfacePageMetadata(page)],
  });

  const decoded = decodeWorldMeshPayload(encoded);
  assertPayloadEqual(decoded, payload);
  assert.deepEqual(Array.from(decoded.worldQuads?.transparent ?? []), transparentBefore);
  assert.equal(decoded.worldQuads?.transparentDepth?.quads?.buffer, encoded.buffer);
  assert.equal(decoded.worldQuads?.transparentDepth?.surfaces[0]?.texels.buffer, encoded.buffer);

  const surfaceOnlyDepth = surfacePayload();
  assert.ok(surfaceOnlyDepth.worldQuads);
  surfaceOnlyDepth.worldQuads.transparent = transparentQuadFixture();
  surfaceOnlyDepth.worldQuads.transparentDepth = { quads: null, surfaces: [surfaceFixturePage()] };
  const surfaceOnlyDecoded = decodeWorldMeshPayload(encodeWorldMeshPayload(surfaceOnlyDepth));
  assertPayloadEqual(surfaceOnlyDecoded, surfaceOnlyDepth);
  assert.equal(surfaceOnlyDecoded.worldQuads?.transparentDepth?.quads, null);
}

function decodesLegacyV1Payloads() {
  const payload = fixturePayload();
  const encoded = encodeLegacyWorldMeshPayload(payload);
  assert.equal(payloadMagic(encoded), MAGIC_V1);
  assert.equal(readMetadata(encoded).rendererVersion, "v1");
  assert.equal(readMetadata(encoded).surfacePages, undefined);
  assert.equal(readMetadata(encoded).transparentDepth, undefined);
  assertPayloadEqual(decodeWorldMeshPayload(encoded), payload);

  assertInvalid(withMetadata(encoded, (metadata) => { metadata.rendererVersion = "v2"; }), /renderer version/);
  const wrongMagic = encoded.slice();
  new DataView(wrongMagic.buffer).setUint32(0, MAGIC_V2, false);
  assertInvalid(wrongMagic, /renderer version/);
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
  assertInvalid(encoded.slice(0, -4), /body byte length mismatch/);

  assertInvalid(withMetadata(encoded, (metadata) => { metadata.rendererVersion = "v1"; }), /renderer version/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.bucketWordLengths.opaque = "4" as never; }), /opaque word length/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.bucketWordLengths.opaque += 1; }), /word length must align/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.anchor = [0.5, "0" as never, 0.5]; }), /anchor must be finite/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.bounds.radius = "1" as never; }), /bounds.radius must be positive/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.bounds.center = [0, 0, 0]; }), /bounds center is inconsistent/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.filteredBlockCount = -1; }), /filteredBlockCount/);
  assertInvalid(withMetadata(encoded, (metadata) => { delete metadata.surfacePages; }), /surface pages must be an array/);
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

function rejectsCorruptSurfacePages() {
  const encoded = encodeWorldMeshPayload(surfacePayload([surfaceFixturePage()]));
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.surfacePages = {} as never; }), /surface pages must be an array/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.surfacePages![0]!.width = 1024; }), /width is unsupported/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.surfacePages![0]!.height = 2049; }), /height is unsupported/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.surfacePages![0]!.quadWordLength = 0; }), /quad word length/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.surfacePages![0]!.quadWordLength += 1; }), /must align to quads/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.surfacePages![0]!.texelWordLength -= 1; }), /texel word length is inconsistent/);
  assertInvalid(encoded.slice(0, -4), /body byte length mismatch/);

  assertInvalid(withSurfaceQuadWord(encoded, 0, 0, (word) => word | 0x40000000), /unsupported coordinate bits/);
  assertInvalid(withSurfaceQuadWord(encoded, 0, 1, (word) => word | 0x800000), /unsupported size bits/);
  assertInvalid(withSurfaceQuadWord(encoded, 0, 1, (word) => (word & ~(0x7 << 20)) | (6 << 20)), /direction is invalid/);
  assertInvalid(withSurfaceQuadWord(encoded, 0, 1, (word) => (word & ~0x3ff) | 17), /extent is invalid/);
  assertInvalid(withSurfaceQuadWord(encoded, 0, 0, (word) => word | (1023 << 10)), /exceeds packed bounds/);
  assertInvalid(withSurfaceQuadWord(encoded, 0, 2, () => 1), /texel offsets are not contiguous/);
  assertInvalid(withSurfaceQuadWord(encoded, 0, WORLD_QUAD_WORDS + 2, () => 5), /texel offsets are not contiguous/);
  assertInvalid(withSurfaceQuadWord(encoded, 0, 3, () => 1), /reserved bits/);
  assertInvalid(withSurfaceQuadWord(encoded, 0, 0, (word) => (word & ~0x3ff) | 3), /exceeds declared bounds/);

  assertInvalid(withSurfaceTexelWord(encoded, 0, 0, () => 0x4), /row mask exceeds width/);
  assertInvalid(withSurfaceTexelWord(encoded, 0, 1, () => 0), /row prefix is invalid/);
  assertInvalid(withSurfaceTexelWord(encoded, 0, 2, () => invalidAtlasCellWord()), /cell atlas word is invalid/);
  assertInvalid(withSurfaceTexelWord(encoded, 0, 2, (word) => word | 0x80000000), /reserved bits/);
  assertInvalid(withSurfaceTexelWord(encoded, 0, 6, () => 1), /padding must be zero/);

  const emptyPage = clonePage(surfaceFixturePage());
  emptyPage.quads = new Uint32Array();
  assert.throws(() => encodeWorldMeshPayload(surfacePayload([emptyPage])), /Invalid world mesh payload: surface page 0 quad word length/);

  const emptyPatch = clonePage(surfaceFixturePage());
  emptyPatch.quads = emptyPatch.quads.slice(0, WORLD_QUAD_WORDS);
  emptyPatch.texels = new Uint32Array(SURFACE_WIDTH);
  assert.throws(() => encodeWorldMeshPayload(surfacePayload([emptyPatch])), /quad has no occupied cells/);

  const paddedTooFar = clonePage(surfaceFixturePage());
  paddedTooFar.height = 2;
  paddedTooFar.texels = new Uint32Array(SURFACE_WIDTH * 2);
  paddedTooFar.texels.set(surfaceFixturePage().texels);
  assert.throws(() => encodeWorldMeshPayload(surfacePayload([paddedTooFar])), /padding is too large/);
}

function encodedTransparentDepthWithoutSource(): Uint8Array {
  const page = surfaceFixturePage();
  const payload = surfacePayload();
  assert.ok(payload.worldQuads);
  return writeMetadata({
    rendererVersion: "v2",
    anchor: payload.worldQuads.anchor,
    bounds: payload.bounds,
    filteredBlockCount: payload.filteredBlockCount,
    bucketWordLengths: Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<WorldQuadBucketName, number>,
    surfacePages: [],
    transparentDepth: {
      quadWordLength: 0,
      surfacePages: [surfacePageMetadata(page)],
    },
  }, surfacePagesBody([page]), MAGIC_V2);
}

function rejectsCorruptTransparentDepth() {
  const payload = surfacePayload();
  assert.ok(payload.worldQuads);
  payload.worldQuads.transparent = transparentQuadFixture();
  payload.worldQuads.transparentDepth = {
    quads: payload.worldQuads.transparent.slice(0, WORLD_QUAD_WORDS),
    surfaces: [surfaceFixturePage()],
  };
  const encoded = encodeWorldMeshPayload(payload);

  assertInvalid(withMetadata(encoded, (metadata) => { metadata.transparentDepth = null as never; }), /transparent depth must be an object/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.transparentDepth!.quadWordLength += 1; }), /transparent depth quad word length must align/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.transparentDepth!.surfacePages = []; }), /transparent depth surface pages are required/);
  assertInvalid(withMetadata(encoded, (metadata) => { metadata.transparentDepth!.surfacePages[0]!.height = 2049; }), /height is unsupported/);
  assertInvalid(withTransparentDepthQuadWord(encoded, 0, (word) => word | 0x40000000), /transparent quad has unsupported coordinate bits/);
  assertInvalid(withSurfaceTexelWord(encoded, 0, 6, () => 1, "transparentDepth"), /padding must be zero/);
  assertInvalid(encodedTransparentDepthWithoutSource(), /transparent depth requires transparent quads/);

  const noSource = surfacePayload();
  assert.ok(noSource.worldQuads);
  noSource.worldQuads.transparentDepth = { quads: null, surfaces: [surfaceFixturePage()] };
  assert.throws(() => encodeWorldMeshPayload(noSource), /transparent depth requires transparent quads/);

  const noPages = surfacePayload();
  assert.ok(noPages.worldQuads);
  noPages.worldQuads.transparent = transparentQuadFixture();
  noPages.worldQuads.transparentDepth = { quads: null, surfaces: [] };
  assert.throws(() => encodeWorldMeshPayload(noPages), /transparent depth surface pages are required/);
}

async function main() {
  await versionIsStable();
  roundTripBucketsAndViews();
  roundTripsSurfacePagesAndViews();
  roundTripsTransparentDepth();
  decodesLegacyV1Payloads();
  rejectsMalformedStructure();
  rejectsCorruptQuads();
  rejectsCorruptSurfacePages();
  rejectsCorruptTransparentDepth();
  console.log("world mesh codec checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
