import assert from "node:assert/strict";
import { packWorldSurfaceTiles, type WorldSurfaceTilePage } from "../../../lib/voxel/worldSurfaceTiles";
import { WORLD_QUAD_WORDS } from "../../../lib/voxel/worldQuadData";

const UNIT = 1 | (1 << 10);

type PackedResult = ReturnType<typeof packWorldSurfaceTiles>;

function quad(
  face: number,
  plane: number,
  u: number,
  v: number,
  width: number,
  height: number,
  atlasU: number,
  atlasV: number,
  flags: number,
): number[] {
  return [
    (plane | (u << 10) | (v << 20)) >>> 0,
    (width | (height << 10) | (face << 20)) >>> 0,
    (atlasU | (atlasV << 16)) >>> 0,
    flags >>> 0,
  ];
}

function surfaceTexel(atlasU: number, atlasV: number, flags: number): number {
  return (atlasU | (atlasV << 10) | (flags << 20)) >>> 0;
}

function cellKey(face: number, plane: number, u: number, v: number): string {
  return `${face}|${plane}|${u}|${v}`;
}

function cellValue(atlasU: number, atlasV: number, flags: number): string {
  return `${atlasU}|${atlasV}|${flags}`;
}

function record(map: Map<string, string>, key: string, value: string): void {
  assert.equal(map.has(key), false, `duplicate cell ${key}`);
  map.set(key, value);
}

function popcount(value: number): number {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function decodeQuads(words: Uint32Array | null): Map<string, string> {
  const cells = new Map<string, string>();
  if (!words) return cells;
  assert.equal(words.length % WORLD_QUAD_WORDS, 0);
  for (let offset = 0; offset < words.length; offset += WORLD_QUAD_WORDS) {
    const word0 = words[offset]!;
    const word1 = words[offset + 1]!;
    const word2 = words[offset + 2]!;
    const word3 = words[offset + 3]!;
    const plane = word0 & 0x3ff;
    const u0 = (word0 >>> 10) & 0x3ff;
    const v0 = (word0 >>> 20) & 0x3ff;
    const width = word1 & 0x3ff;
    const height = (word1 >>> 10) & 0x3ff;
    const face = (word1 >>> 20) & 0x7;
    for (let v = 0; v < height; v += 1) {
      for (let u = 0; u < width; u += 1) {
        record(cells, cellKey(face, plane, u0 + u, v0 + v), cellValue(word2 & 0xffff, word2 >>> 16, word3));
      }
    }
  }
  return cells;
}

function decodePacked(result: PackedResult): Map<string, string> {
  const cells = decodeQuads(result.opaque);
  for (const page of result.surfaces) {
    assert.equal(page.width, 2048);
    assert.equal(page.texels.length, page.width * page.height);
    assert.equal(page.quads.length % WORLD_QUAD_WORDS, 0);
    for (let offset = 0; offset < page.quads.length; offset += WORLD_QUAD_WORDS) {
      const word0 = page.quads[offset]!;
      const word1 = page.quads[offset + 1]!;
      const texelOffset = page.quads[offset + 2]!;
      assert.equal(page.quads[offset + 3], 0);
      const plane = word0 & 0x3ff;
      const u0 = (word0 >>> 10) & 0x3ff;
      const v0 = (word0 >>> 20) & 0x3ff;
      const width = word1 & 0x3ff;
      const height = (word1 >>> 10) & 0x3ff;
      const face = (word1 >>> 20) & 0x7;
      let seen = 0;
      for (let v = 0; v < height; v += 1) {
        const header = page.texels[texelOffset + v]! >>> 0;
        const mask = header & 0xffff;
        assert.equal(header >>> 16, seen);
        assert.equal(width === 16 ? 0 : mask >>> width, 0);
        for (let u = 0; u < width; u += 1) {
          if ((mask & (1 << u)) === 0) continue;
          const texel = page.texels[texelOffset + height + (header >>> 16) + popcount(mask & ((1 << u) - 1))]! >>> 0;
          record(cells, cellKey(face, plane, u0 + u, v0 + v), cellValue(texel & 0x3ff, (texel >>> 10) & 0x3ff, (texel >>> 20) & 0x7ff));
        }
        seen += popcount(mask);
      }
      assert.ok(texelOffset + height + seen <= page.texels.length);
    }
  }
  return cells;
}

function findQuad(page: WorldSurfaceTilePage, face: number, plane: number, u: number, v: number): number {
  for (let offset = 0; offset < page.quads.length; offset += WORLD_QUAD_WORDS) {
    const word0 = page.quads[offset]!;
    const word1 = page.quads[offset + 1]!;
    if (
      (word1 >>> 20) === face &&
      (word0 & 0x3ff) === plane &&
      ((word0 >>> 10) & 0x3ff) === u &&
      ((word0 >>> 20) & 0x3ff) === v
    ) {
      return offset;
    }
  }
  assert.fail(`missing surface quad ${face}|${plane}|${u}|${v}`);
}

function assertMapsEqual(actual: Map<string, string>, expected: Map<string, string>): void {
  assert.equal(actual.size, expected.size);
  for (const [key, value] of expected) assert.equal(actual.get(key), value, key);
}

function packsSparseTilesExactly() {
  const keptLarge = quad(2, 11, 60, 12, 2, 3, 21, 22, 5);
  const keptNonflat = quad(1, 22, 40, 40, 4, 2, 25, 26, 913);
  const keptTooLarge = quad(1, 23, 50, 50, 17, 1, 27, 28, 1023);
  const keptAtlasU = quad(3, 12, 4, 4, 1, 1, 1024, 23, 9);
  const keptAtlasV = quad(4, 13, 5, 5, 1, 1, 24, 1024, 10);
  const input = new Uint32Array([
    ...quad(0, 7, 0, 0, 1, 1, 0, 0, 0),
    ...quad(0, 7, 2, 1, 1, 1, 5, 6, 1023),
    ...quad(0, 7, 15, 0, 1, 1, 3, 4, 2047),
    ...quad(0, 7, 16, 0, 1, 1, 9, 10, 7),
    ...quad(0, 7, 17, 1, 1, 1, 11, 12, 8),
    ...keptLarge,
    ...quad(5, 19, 0, 0, 16, 1, 13, 14, 2047),
    ...quad(2, 20, 14, 14, 4, 4, 15, 16, 1023),
    ...quad(5, 21, 0, 0, 1, 1, 17, 18, 1),
    ...quad(5, 21, 0, 15, 1, 1, 19, 20, 2),
    ...keptNonflat,
    ...keptTooLarge,
    ...keptAtlasU,
    ...keptAtlasV,
    ...quad(1, 8, 1, 2, 1, 1, 30, 31, 1),
    ...quad(2, 9, 2, 3, 1, 1, 32, 33, 2),
    ...quad(3, 10, 3, 4, 1, 1, 34, 35, 3),
    ...quad(4, 11, 4, 5, 1, 1, 36, 37, 4),
    ...quad(5, 12, 5, 6, 1, 1, 38, 39, 5),
  ]);
  const original = input.slice();
  const result = packWorldSurfaceTiles(input);
  assert.deepEqual(Array.from(input), Array.from(original));
  assert.deepEqual(Array.from(result.opaque ?? []), [...keptLarge, ...keptNonflat, ...keptTooLarge, ...keptAtlasU, ...keptAtlasV]);
  assert.equal(result.surfaces.length, 1);

  const page = result.surfaces[0]!;
  assert.equal(page.quads.length / WORLD_QUAD_WORDS, 13);
  const sparseOffset = findQuad(page, 0, 7, 0, 0);
  assert.equal(page.quads[sparseOffset + 1] & 0xfffff, 16 | (2 << 10));
  const sparseTexelOffset = page.quads[sparseOffset + 2]!;
  assert.equal(page.texels[sparseTexelOffset], 0x8001);
  assert.equal(page.texels[sparseTexelOffset + 1], 0x20004);
  assert.equal(page.texels[sparseTexelOffset + 2], 0);
  assert.equal(page.texels[sparseTexelOffset + 3], surfaceTexel(3, 4, 2047));
  assert.equal(page.texels[sparseTexelOffset + 3]! >>> 31, 0);
  assert.equal(page.texels[sparseTexelOffset + 3]! >>> 30, 1);
  assert.equal(page.texels[sparseTexelOffset + 4], surfaceTexel(5, 6, 1023));

  const fullRowOffset = findQuad(page, 5, 19, 0, 0);
  const fullRowBase = page.quads[fullRowOffset + 2]!;
  assert.equal(page.quads[fullRowOffset + 1] & 0xfffff, 16 | (1 << 10));
  assert.equal(page.texels[fullRowBase], 0xffff);
  assert.equal(page.texels[fullRowBase + 16], surfaceTexel(13, 14, 2047));

  const sparseRowsOffset = findQuad(page, 5, 21, 0, 0);
  const sparseRowsBase = page.quads[sparseRowsOffset + 2]!;
  assert.equal(page.quads[sparseRowsOffset + 1] & 0xfffff, 1 | (16 << 10));
  assert.equal(page.texels[sparseRowsBase], 0x1);
  assert.equal(page.texels[sparseRowsBase + 1], 0x10000);
  assert.equal(page.texels[sparseRowsBase + 15], 0x10001);

  assert.equal(page.quads[findQuad(page, 2, 20, 14, 14) + 1] & 0xfffff, 2 | (2 << 10));
  assert.equal(page.quads[findQuad(page, 2, 20, 16, 14) + 1] & 0xfffff, 2 | (2 << 10));
  assert.equal(page.quads[findQuad(page, 2, 20, 14, 16) + 1] & 0xfffff, 2 | (2 << 10));
  assert.equal(page.quads[findQuad(page, 2, 20, 16, 16) + 1] & 0xfffff, 2 | (2 << 10));

  assertMapsEqual(decodePacked(result), decodeQuads(input));
}

function handlesEmptyFallbackAndDeterminism() {
  assert.deepEqual(packWorldSurfaceTiles(null), { opaque: null, surfaces: [] });
  assert.deepEqual(packWorldSurfaceTiles(new Uint32Array()), { opaque: null, surfaces: [] });

  const input = new Uint32Array(quad(0, 1, 2, 3, 2, 1, 4, 5, 6));
  const fallback = packWorldSurfaceTiles(input);
  assert.notEqual(fallback.opaque, input);
  assert.deepEqual(Array.from(fallback.opaque ?? []), Array.from(input));
  assert.equal(fallback.surfaces.length, 0);

  const mixed = new Uint32Array([
    ...quad(0, 2, 18, 18, 1, 1, 6, 7, 8),
    ...quad(0, 2, 16, 16, 1, 1, 9, 10, 11),
    ...quad(1, 3, 1, 1, 1, 1, 12, 13, 14),
  ]);
  const first = packWorldSurfaceTiles(mixed);
  const second = packWorldSurfaceTiles(mixed);
  assert.deepEqual(Array.from(first.opaque ?? []), Array.from(second.opaque ?? []));
  assert.equal(first.surfaces.length, second.surfaces.length);
  for (let index = 0; index < first.surfaces.length; index += 1) {
    assert.deepEqual(Array.from(first.surfaces[index]!.quads), Array.from(second.surfaces[index]!.quads));
    assert.deepEqual(Array.from(first.surfaces[index]!.texels), Array.from(second.surfaces[index]!.texels));
  }
}

function rejectsDuplicateCells() {
  const input = new Uint32Array([
    ...quad(0, 1, 2, 3, 1, 1, 4, 5, 6),
    ...quad(0, 1, 2, 3, 1, 1, 7, 8, 9),
  ]);
  assert.throws(() => packWorldSurfaceTiles(input), /Duplicate world surface tile cell/);
}

function rejectsMisalignedInput() {
  assert.throws(() => packWorldSurfaceTiles(new Uint32Array([1, UNIT, 2])), /four words per face/);
}

packsSparseTilesExactly();
handlesEmptyFallbackAndDeterminism();
rejectsDuplicateCells();
rejectsMisalignedInput();
console.log("world surface tile checks passed");
