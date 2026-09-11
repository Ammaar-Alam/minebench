import assert from "node:assert/strict";
import { ATLAS } from "../../../lib/blocks/atlas";
import { getPalette } from "../../../lib/blocks/palettes";
import { DIRS, type Direction } from "../../../lib/voxel/ambientOcclusion";
import type { VoxelMeshPayload } from "../../../lib/voxel/mesh";
import { buildMeshPayload } from "../../../lib/voxel/mesh.worker";
import type { SerializedMeshBucket } from "../../../lib/voxel/meshBuckets";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { buildWorldRegionGreedyMeshPayload } from "../../../lib/voxel/worldRegionMesh";
import {
  WORLD_QUAD_COLORS,
  WORLD_QUAD_WORDS,
  type WorldQuadBucketName,
  type WorldQuadPayload,
} from "../../../lib/voxel/worldQuadData";

const allowed = getPalette("simple").map((entry) => entry.id);
const bucketNames = ["opaque", "cutout", "transparent", "water", "emissive"] as const;
const uvTolerance = 2 / 65535;

type BucketName = (typeof bucketNames)[number];
type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];
type DecodedMeshBucket = SerializedMeshBucket & { atlasUvFrames?: Float32Array };
type DecodedMeshPayload = Omit<VoxelMeshPayload, BucketName> & Record<BucketName, DecodedMeshBucket | null>;
type CompactMeshPayload = VoxelMeshPayload & { worldQuads: WorldQuadPayload };

type FaceSample = {
  bucket: BucketName;
  corners: Vec3[];
  colors: Vec3[];
  frame: Vec4 | null;
  basis: { s: Vec2; t: Vec2 } | null;
  uvs: Vec2[];
  flipDiagonal: boolean;
};

function compactPayload(payload: VoxelMeshPayload): CompactMeshPayload {
  assert.ok(payload.worldQuads, "world greedy mesh must return compact world quads");
  return payload as CompactMeshPayload;
}

function assertLegacyBucketsNull(payload: VoxelMeshPayload): void {
  for (const bucketName of bucketNames) {
    assert.equal(payload[bucketName], null, `${bucketName} legacy bucket should be null`);
  }
}

function assertCompactBuckets(payload: CompactMeshPayload): void {
  for (const bucketName of bucketNames) {
    const words = payload.worldQuads[bucketName as WorldQuadBucketName];
    if (!words) continue;
    assert.equal(words.length % WORLD_QUAD_WORDS, 0, `${bucketName} word count must align to quads`);
  }
}

function normalizedUv(uvs: Float32Array | Uint16Array, offset: number): number {
  const value = uvs[offset] ?? 0;
  return uvs instanceof Uint16Array ? value / 65535 : value;
}

function vertex3(bucket: DecodedMeshBucket, vertex: number): Vec3 {
  const offset = vertex * 3;
  return [
    bucket.positions[offset] ?? 0,
    bucket.positions[offset + 1] ?? 0,
    bucket.positions[offset + 2] ?? 0,
  ];
}

function normal3(bucket: DecodedMeshBucket, vertex: number): Vec3 {
  const offset = vertex * 3;
  return [
    Math.round((bucket.normals[offset] ?? 0) / 127),
    Math.round((bucket.normals[offset + 1] ?? 0) / 127),
    Math.round((bucket.normals[offset + 2] ?? 0) / 127),
  ];
}

function color3(bucket: DecodedMeshBucket, vertex: number): Vec3 {
  const offset = vertex * 3;
  return [
    bucket.colors[offset] ?? 0,
    bucket.colors[offset + 1] ?? 0,
    bucket.colors[offset + 2] ?? 0,
  ];
}

function uv2(bucket: DecodedMeshBucket, vertex: number): Vec2 {
  const offset = vertex * 2;
  return [normalizedUv(bucket.uvs, offset), normalizedUv(bucket.uvs, offset + 1)];
}

function frame4(bucket: DecodedMeshBucket, vertex: number): Vec4 | null {
  if (!bucket.atlasUvFrames) return null;
  const offset = vertex * 4;
  return [
    bucket.atlasUvFrames[offset] ?? 0,
    bucket.atlasUvFrames[offset + 1] ?? 0,
    bucket.atlasUvFrames[offset + 2] ?? 0,
    bucket.atlasUvFrames[offset + 3] ?? 0,
  ];
}

function quadFlipped(bucket: DecodedMeshBucket, quad: number): boolean {
  const base = quad * 4;
  const offset = quad * 6;
  const indices = Array.from(bucket.indices.subarray(offset, offset + 6), (index) => index - base).join(",");
  if (indices === "0,1,2,0,2,3") return false;
  if (indices === "1,2,3,1,3,0") return true;
  assert.fail(`unexpected quad index pattern ${indices}`);
}

function span(a: Vec3, b: Vec3): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

function pointAt(corner: Vec3[], s: number, t: number, sSpan: number, tSpan: number): Vec3 {
  const sRatio = s / sSpan;
  const tRatio = t / tSpan;
  return [
    corner[0]![0] + (corner[1]![0] - corner[0]![0]) * sRatio + (corner[3]![0] - corner[0]![0]) * tRatio,
    corner[0]![1] + (corner[1]![1] - corner[0]![1]) * sRatio + (corner[3]![1] - corner[0]![1]) * tRatio,
    corner[0]![2] + (corner[1]![2] - corner[0]![2]) * sRatio + (corner[3]![2] - corner[0]![2]) * tRatio,
  ];
}

function uvAt(corner: Vec2[], s: number, t: number, sSpan: number, tSpan: number): Vec2 {
  const sRatio = s / sSpan;
  const tRatio = t / tSpan;
  return [
    corner[0]![0] + (corner[1]![0] - corner[0]![0]) * sRatio + (corner[3]![0] - corner[0]![0]) * tRatio,
    corner[0]![1] + (corner[1]![1] - corner[0]![1]) * sRatio + (corner[3]![1] - corner[0]![1]) * tRatio,
  ];
}

function faceKey(bucket: BucketName, normal: Vec3, corners: Vec3[]): string {
  const min = (axis: 0 | 1 | 2) => Math.min(...corners.map((corner) => corner[axis]));
  const fixed = normal[0] !== 0 ? corners[0]![0] : normal[1] !== 0 ? corners[0]![1] : corners[0]![2];
  const a = normal[0] !== 0 ? min(1) : min(0);
  const b = normal[1] !== 0 ? min(2) : normal[2] !== 0 ? min(1) : min(2);
  return `${bucket}|${normal.join(",")}|${fixed.toFixed(6)}|${a.toFixed(6)}|${b.toFixed(6)}`;
}

function colorsForUnit(colors: Vec3[], sSpan: number, tSpan: number): Vec3[] {
  const first = colors[0]!;
  if (colors.every((color) => color[0] === first[0] && color[1] === first[1] && color[2] === first[2])) {
    return [first, first, first, first];
  }
  assert.equal(sSpan, 1);
  assert.equal(tSpan, 1);
  return colors;
}

function frameFromUvs(uvs: Vec2[]): Vec4 {
  return [
    Math.min(...uvs.map((uv) => uv[0])),
    Math.min(...uvs.map((uv) => uv[1])),
    Math.max(...uvs.map((uv) => uv[0])),
    Math.max(...uvs.map((uv) => uv[1])),
  ];
}

function uvBasis(uvs: Vec2[], frame: Vec4 | null, bucket: BucketName): FaceSample["basis"] {
  if (bucket === "water") return null;
  const divisor = frame
    ? [1, 1]
    : (() => {
        const legacyFrame = frameFromUvs(uvs);
        return [legacyFrame[2] - legacyFrame[0], legacyFrame[3] - legacyFrame[1]];
      })();
  return {
    s: [(uvs[1]![0] - uvs[0]![0]) / divisor[0], (uvs[1]![1] - uvs[0]![1]) / divisor[1]],
    t: [(uvs[3]![0] - uvs[0]![0]) / divisor[0], (uvs[3]![1] - uvs[0]![1]) / divisor[1]],
  };
}

function collectFaceSamples(payload: DecodedMeshPayload): Map<string, FaceSample> {
  const samples = new Map<string, FaceSample>();
  for (const bucketName of bucketNames) {
    const bucket = payload[bucketName];
    if (!bucket) continue;
    const quadCount = bucket.positions.length / 12;
    for (let quad = 0; quad < quadCount; quad += 1) {
      const vertexOffset = quad * 4;
      const corners = [0, 1, 2, 3].map((index) => vertex3(bucket, vertexOffset + index));
      const normal = normal3(bucket, vertexOffset);
      const colors = [0, 1, 2, 3].map((index) => color3(bucket, vertexOffset + index));
      const uvs = [0, 1, 2, 3].map((index) => uv2(bucket, vertexOffset + index));
      const frame = frame4(bucket, vertexOffset);
      const sSpan = Math.round(span(corners[0]!, corners[1]!));
      const tSpan = Math.round(span(corners[0]!, corners[3]!));
      assert.ok(sSpan > 0, "face sample must span at least one block");
      assert.ok(tSpan > 0, "face sample must span at least one block");

      for (let s = 0; s < sSpan; s += 1) {
        for (let t = 0; t < tSpan; t += 1) {
          const unitCorners = [
            pointAt(corners, s, t, sSpan, tSpan),
            pointAt(corners, s + 1, t, sSpan, tSpan),
            pointAt(corners, s + 1, t + 1, sSpan, tSpan),
            pointAt(corners, s, t + 1, sSpan, tSpan),
          ];
          const unitUvs = [
            uvAt(uvs, s, t, sSpan, tSpan),
            uvAt(uvs, s + 1, t, sSpan, tSpan),
            uvAt(uvs, s + 1, t + 1, sSpan, tSpan),
            uvAt(uvs, s, t + 1, sSpan, tSpan),
          ];
          const key = faceKey(bucketName, normal, unitCorners);
          assert.equal(samples.has(key), false, `duplicate face sample ${key}`);
          samples.set(key, {
            bucket: bucketName,
            corners: unitCorners,
            colors: colorsForUnit(colors, sSpan, tSpan),
            frame: bucketName === "water" ? null : frame ?? frameFromUvs(unitUvs),
            basis: uvBasis(unitUvs, frame, bucketName),
            uvs: unitUvs,
            flipDiagonal: quadFlipped(bucket, quad),
          });
        }
      }
    }
  }
  return samples;
}

function assertNear(actual: number, expected: number, message: string, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

function assertVecClose(actual: readonly number[], expected: readonly number[], message: string, tolerance = 1e-6): void {
  assert.equal(actual.length, expected.length, message);
  for (let index = 0; index < actual.length; index += 1) {
    assertNear(actual[index]!, expected[index]!, `${message}[${index}]`, tolerance);
  }
}

function assertSamplesMatchLegacy(legacy: DecodedMeshPayload, decodedCompact: DecodedMeshPayload): void {
  const expected = collectFaceSamples(legacy);
  const actual = collectFaceSamples(decodedCompact);
  assert.equal(actual.size, expected.size);
  assert.ok(
    Array.from(expected.values()).some((sample) =>
      sample.bucket === "opaque" &&
      new Set(sample.colors.map((color) => color.join(","))).size > 1,
    ),
    "fixture must include non-flat AO",
  );
  assert.ok(Array.from(expected.values()).some((sample) => sample.flipDiagonal), "fixture must include a flipped diagonal");
  for (const bucketName of bucketNames) {
    assert.ok(Array.from(expected.values()).some((sample) => sample.bucket === bucketName), `missing ${bucketName} sample`);
  }

  for (const [key, expectedSample] of expected) {
    const actualSample = actual.get(key);
    assert.ok(actualSample, `missing compact face sample ${key}`);
    assert.equal(actualSample.flipDiagonal, expectedSample.flipDiagonal, `${key} diagonal`);
    for (let index = 0; index < 4; index += 1) {
      assertVecClose(actualSample.corners[index]!, expectedSample.corners[index]!, `${key} corner ${index}`);
      assert.deepEqual(actualSample.colors[index], expectedSample.colors[index], `${key} color ${index}`);
    }
    if (expectedSample.bucket === "water") {
      for (let index = 0; index < 4; index += 1) {
        assertVecClose(actualSample.uvs[index]!, expectedSample.uvs[index]!, `${key} water uv ${index}`, 1e-6);
      }
      continue;
    }
    assert.ok(actualSample.frame);
    assert.ok(expectedSample.frame);
    assertVecClose(actualSample.frame, expectedSample.frame, `${key} atlas frame`, uvTolerance);
    assert.ok(actualSample.basis);
    assert.ok(expectedSample.basis);
    assertVecClose(actualSample.basis.s, expectedSample.basis.s, `${key} uv s`, uvTolerance);
    assertVecClose(actualSample.basis.t, expectedSample.basis.t, `${key} uv t`, uvTolerance);
  }
}

function vertexLocalPosition(anchor: Vec3, x: number, y: number, z: number): [number, number, number] {
  return [x - anchor[0], y - anchor[1], z - anchor[2]];
}

function rectVerts(
  face: Direction["face"],
  plane: number,
  u: number,
  v: number,
  width: number,
  height: number,
  anchor: Vec3,
): [number, number, number][] {
  const u1 = u + width;
  const v1 = v + height;
  switch (face) {
    case "east":
      return [
        vertexLocalPosition(anchor, plane, v, u),
        vertexLocalPosition(anchor, plane, v1, u),
        vertexLocalPosition(anchor, plane, v1, u1),
        vertexLocalPosition(anchor, plane, v, u1),
      ];
    case "west":
      return [
        vertexLocalPosition(anchor, plane, v, u1),
        vertexLocalPosition(anchor, plane, v1, u1),
        vertexLocalPosition(anchor, plane, v1, u),
        vertexLocalPosition(anchor, plane, v, u),
      ];
    case "north":
      return [
        vertexLocalPosition(anchor, u, v, plane),
        vertexLocalPosition(anchor, u, v1, plane),
        vertexLocalPosition(anchor, u1, v1, plane),
        vertexLocalPosition(anchor, u1, v, plane),
      ];
    case "south":
      return [
        vertexLocalPosition(anchor, u1, v, plane),
        vertexLocalPosition(anchor, u1, v1, plane),
        vertexLocalPosition(anchor, u, v1, plane),
        vertexLocalPosition(anchor, u, v, plane),
      ];
    case "up":
      return [
        vertexLocalPosition(anchor, u, plane, v1),
        vertexLocalPosition(anchor, u1, plane, v1),
        vertexLocalPosition(anchor, u1, plane, v),
        vertexLocalPosition(anchor, u, plane, v),
      ];
    case "down":
      return [
        vertexLocalPosition(anchor, u, plane, v),
        vertexLocalPosition(anchor, u1, plane, v),
        vertexLocalPosition(anchor, u1, plane, v1),
        vertexLocalPosition(anchor, u, plane, v1),
      ];
  }
}

function waterRectVerts(
  face: Direction["face"],
  plane: number,
  u: number,
  v: number,
  width: number,
  height: number,
  anchor: Vec3,
): [number, number, number][] {
  const u1 = u + width;
  const v1 = v + height;
  switch (face) {
    case "east":
      return [
        vertexLocalPosition(anchor, plane, u, v),
        vertexLocalPosition(anchor, plane, u1, v),
        vertexLocalPosition(anchor, plane, u1, v1),
        vertexLocalPosition(anchor, plane, u, v1),
      ];
    case "west":
      return [
        vertexLocalPosition(anchor, plane, u, v1),
        vertexLocalPosition(anchor, plane, u1, v1),
        vertexLocalPosition(anchor, plane, u1, v),
        vertexLocalPosition(anchor, plane, u, v),
      ];
    default:
      return rectVerts(face, plane, u, v, width, height, anchor);
  }
}

function rectUv(width: number, height: number): Vec2[] {
  return [[0, 0], [0, height], [width, height], [width, 0]];
}

function faceUv(face: Direction["face"], width: number, height: number): Vec2[] {
  return face === "up" || face === "down" ? rectUv(height, width) : rectUv(width, height);
}

function atlasFrame(word: number): Vec4 {
  const u0 = word & 0xffff;
  const v0 = word >>> 16;
  return [
    u0 / ATLAS.atlasWidth,
    v0 / ATLAS.atlasHeight,
    (u0 + ATLAS.tileSize) / ATLAS.atlasWidth,
    (v0 + ATLAS.tileSize) / ATLAS.atlasHeight,
  ];
}

function writeDecodedQuad(
  bucket: DecodedMeshBucket,
  bucketName: BucketName,
  quad: number,
  words: Uint32Array,
  anchor: Vec3,
): void {
  const wordOffset = quad * WORLD_QUAD_WORDS;
  const word0 = words[wordOffset]!;
  const word1 = words[wordOffset + 1]!;
  const word2 = words[wordOffset + 2]!;
  const word3 = words[wordOffset + 3]!;
  const plane = word0 & 0x3ff;
  const u = (word0 >>> 10) & 0x3ff;
  const v = (word0 >>> 20) & 0x3ff;
  const width = word1 & 0x3ff;
  const height = (word1 >>> 10) & 0x3ff;
  const directionIndex = (word1 >>> 20) & 0x7;
  const direction = DIRS[directionIndex];
  assert.ok(direction, `invalid direction index ${directionIndex}`);
  const packedAoByte = (word3 >>> 2) & 0xff;
  const flipDiagonal = ((word3 >>> 10) & 0x1) === 1;
  const tintIndex = word3 & 0x3;
  const verts = bucketName === "water"
    ? waterRectVerts(direction.face, plane, u, v, width, height, anchor)
    : rectVerts(direction.face, plane, u, v, width, height, anchor);
  const uvs = bucketName === "water" ? rectUv(width, height) : faceUv(direction.face, width, height);
  const frame = bucketName === "water" ? null : atlasFrame(word2);
  const vertexOffset = quad * 4;

  for (let corner = 0; corner < 4; corner += 1) {
    const vertex = vertexOffset + corner;
    const positionOffset = vertex * 3;
    const uvOffset = vertex * 2;
    const frameOffset = vertex * 4;
    const colorLevel = (packedAoByte >> (corner * 2)) & 0x3;
    const colorOffset = (tintIndex * 4 + colorLevel) * 3;
    const vert = verts[corner]!;
    const uv = uvs[corner]!;

    bucket.positions[positionOffset] = vert[0];
    bucket.positions[positionOffset + 1] = vert[1];
    bucket.positions[positionOffset + 2] = vert[2];
    bucket.normals[positionOffset] = direction.nx * 127;
    bucket.normals[positionOffset + 1] = direction.ny * 127;
    bucket.normals[positionOffset + 2] = direction.nz * 127;
    bucket.colors[positionOffset] = Math.round(WORLD_QUAD_COLORS[colorOffset]! * 255);
    bucket.colors[positionOffset + 1] = Math.round(WORLD_QUAD_COLORS[colorOffset + 1]! * 255);
    bucket.colors[positionOffset + 2] = Math.round(WORLD_QUAD_COLORS[colorOffset + 2]! * 255);
    bucket.uvs[uvOffset] = uv[0];
    bucket.uvs[uvOffset + 1] = uv[1];

    if (bucket.atlasUvFrames && frame) {
      bucket.atlasUvFrames[frameOffset] = frame[0];
      bucket.atlasUvFrames[frameOffset + 1] = frame[1];
      bucket.atlasUvFrames[frameOffset + 2] = frame[2];
      bucket.atlasUvFrames[frameOffset + 3] = frame[3];
    }
  }

  const indexOffset = quad * 6;
  if (flipDiagonal) {
    bucket.indices[indexOffset] = vertexOffset + 1;
    bucket.indices[indexOffset + 1] = vertexOffset + 2;
    bucket.indices[indexOffset + 2] = vertexOffset + 3;
    bucket.indices[indexOffset + 3] = vertexOffset + 1;
    bucket.indices[indexOffset + 4] = vertexOffset + 3;
    bucket.indices[indexOffset + 5] = vertexOffset;
  } else {
    bucket.indices[indexOffset] = vertexOffset;
    bucket.indices[indexOffset + 1] = vertexOffset + 1;
    bucket.indices[indexOffset + 2] = vertexOffset + 2;
    bucket.indices[indexOffset + 3] = vertexOffset;
    bucket.indices[indexOffset + 4] = vertexOffset + 2;
    bucket.indices[indexOffset + 5] = vertexOffset + 3;
  }
}

function decodeBucket(words: Uint32Array | null, bucketName: BucketName, anchor: Vec3): DecodedMeshBucket | null {
  if (!words) return null;
  assert.equal(words.length % WORLD_QUAD_WORDS, 0);
  const quadCount = words.length / WORLD_QUAD_WORDS;
  const bucket: DecodedMeshBucket = {
    positions: new Float32Array(quadCount * 4 * 3),
    normals: new Int8Array(quadCount * 4 * 3),
    uvs: new Float32Array(quadCount * 4 * 2),
    colors: new Uint8Array(quadCount * 4 * 3),
    indices: new Uint32Array(quadCount * 6),
    ...(bucketName === "water" ? {} : { atlasUvFrames: new Float32Array(quadCount * 4 * 4) }),
  };

  for (let quad = 0; quad < quadCount; quad += 1) {
    writeDecodedQuad(bucket, bucketName, quad, words, anchor);
  }

  return bucket;
}

function decodeCompactPayload(payload: CompactMeshPayload): DecodedMeshPayload {
  const anchor = payload.worldQuads.anchor;
  return {
    opaque: decodeBucket(payload.worldQuads.opaque, "opaque", anchor),
    cutout: decodeBucket(payload.worldQuads.cutout, "cutout", anchor),
    transparent: decodeBucket(payload.worldQuads.transparent, "transparent", anchor),
    water: decodeBucket(payload.worldQuads.water, "water", anchor),
    emissive: decodeBucket(payload.worldQuads.emissive, "emissive", anchor),
    bounds: payload.bounds,
    filteredBlockCount: payload.filteredBlockCount,
  };
}

{
  const packed = packVoxelBlocks([
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 0, y: 0, z: 1, type: "stone" },
    { x: 0, y: 0, z: 2, type: "stone" },
    { x: 1, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 2, type: "stone" },
    { x: 2, y: 0, z: 0, type: "stone" },
    { x: 2, y: 0, z: 1, type: "stone" },
    { x: 2, y: 0, z: 2, type: "stone" },
    { x: 1, y: 1, z: 0, type: "stone" },
    { x: 2, y: 1, z: 0, type: "stone" },
    { x: 2, y: 2, z: 0, type: "stone" },
    { x: 3, y: 0, z: 0, type: "grass_block" },
    { x: 4, y: 0, z: 0, type: "glass" },
    { x: 4, y: 0, z: 2, type: "oak_leaves" },
    { x: 5, y: 0, z: 0, type: "glowstone" },
    { x: 5, y: 0, z: 2, type: "water" },
    { x: 5, y: 1, z: 2, type: "water" },
    { x: 5, y: 0, z: 3, type: "water" },
  ]);

  const legacy = buildMeshPayload(packed, allowed) as DecodedMeshPayload;
  const compact = compactPayload(buildWorldRegionGreedyMeshPayload(packed, allowed, {
    size: { x: 6, y: 3, z: 4 },
  }));

  assertLegacyBucketsNull(compact);
  assertCompactBuckets(compact);
  assert.equal(compact.filteredBlockCount, legacy.filteredBlockCount);
  assertSamplesMatchLegacy(legacy, decodeCompactPayload(compact));
}

{
  const packed = packVoxelBlocks([
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "stone" },
    { x: 0, y: 0, z: 1, type: "stone" },
    { x: 1, y: 0, z: 1, type: "stone" },
  ]);

  const compact = compactPayload(buildWorldRegionGreedyMeshPayload(packed, allowed, {
    size: { x: 2, y: 1, z: 2 },
  }));
  const worker = compactPayload(buildMeshPayload(packed, allowed, undefined, {
    size: { x: 2, y: 1, z: 2 },
  }));
  const decoded = decodeCompactPayload(compact);

  assert.deepEqual(worker.worldQuads, compact.worldQuads);
  assertLegacyBucketsNull(compact);
  assert.equal(compact.filteredBlockCount, 4);
  assert.equal(compact.worldQuads.opaque?.length, 6 * WORLD_QUAD_WORDS);
  assert.equal(decoded.opaque?.indices.length, 36);
  assert.equal(compact.worldQuads.opaque?.byteLength, 6 * WORLD_QUAD_WORDS * 4);
}

{
  const packed = packVoxelBlocks([
    { x: 0, y: 0, z: 0, type: "grass_block" },
    { x: 1, y: 0, z: 0, type: "dirt" },
  ]);
  const words = compactPayload(buildWorldRegionGreedyMeshPayload(packed, allowed, {
    size: { x: 2, y: 1, z: 1 },
  })).worldQuads.opaque!;
  const bottoms = [];
  for (let offset = 0; offset < words.length; offset += WORLD_QUAD_WORDS) {
    if (DIRS[(words[offset + 1] >>> 20) & 7].face === "down") bottoms.push(offset);
  }
  assert.equal(bottoms.length, 2, "different block types retain separate planes even when their texture matches");
  assert.equal(words[bottoms[0] + 2], words[bottoms[1] + 2]);
}

{
  const packed = packVoxelBlocks([{ x: 0, y: 0, z: 0, type: "stone" }]);
  const halo = packVoxelBlocks([{ x: 1, y: 0, z: 0, type: "stone" }]);
  const compact = compactPayload(buildWorldRegionGreedyMeshPayload(packed, allowed, {
    size: { x: 2, y: 1, z: 1 },
    halo,
  }));
  const decoded = decodeCompactPayload(compact);

  assertLegacyBucketsNull(compact);
  assert.equal(compact.filteredBlockCount, 1);
  assert.equal(compact.worldQuads.opaque?.length, 5 * WORLD_QUAD_WORDS);
  assert.equal(decoded.opaque?.indices.length, 30);
  assert.deepEqual(compact.worldQuads.anchor, [0.5, 0, 0.5]);
  assert.deepEqual(compact.bounds.min, [-0.5, 0, -0.5]);
  assert.deepEqual(compact.bounds.max, [0.5, 1, 0.5]);
}

{
  const compact = compactPayload(buildWorldRegionGreedyMeshPayload(
    packVoxelBlocks([{ x: 0, y: 0, z: 0, type: "stone" }]),
    allowed,
    { size: { x: 1, y: 1, z: 1 } },
  ));

  assertLegacyBucketsNull(compact);
  assert.equal(WORLD_QUAD_COLORS.length, 4 * 4 * 3);
  assert.deepEqual(Array.from(WORLD_QUAD_COLORS.subarray(9, 12)), [1, 1, 1]);
  assert.deepEqual(compact.worldQuads.anchor, [0.5, 0, 0.5]);
  assert.equal(compact.worldQuads.opaque?.length, 6 * WORLD_QUAD_WORDS);
}

{
  const compact = compactPayload(buildWorldRegionGreedyMeshPayload(
    packVoxelBlocks([{ x: 1022, y: 1022, z: 1022, type: "stone" }]),
    allowed,
    { size: { x: 1023, y: 1023, z: 1023 } },
  ));

  assertLegacyBucketsNull(compact);
  assert.equal(compact.filteredBlockCount, 1);
  assert.equal(compact.worldQuads.opaque?.length, 6 * WORLD_QUAD_WORDS);
}

console.log("world greedy mesh checks passed");
