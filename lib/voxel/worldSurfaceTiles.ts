import { WORLD_QUAD_WORDS } from "@/lib/voxel/worldQuadData";

const TILE_SIZE = 16;
const TILE_AXIS = 1024 / TILE_SIZE;
const PAGE_WIDTH = 2048;
const PAGE_TEXELS = PAGE_WIDTH * PAGE_WIDTH;
const UNIT_DIMENSIONS = 1 | (1 << 10);
const COORD_MASK = 0x3ff;
const PACKED_FLAG_MASK = 0x7ff;

export type WorldSurfaceTilePage = {
  quads: Uint32Array;
  texels: Uint32Array;
  width: number;
  height: number;
};

export function packWorldSurfaceTiles(
  opaque: Uint32Array | null,
): { opaque: Uint32Array | null; surfaces: WorldSurfaceTilePage[] } {
  if (!opaque?.length) return { opaque: null, surfaces: [] };
  if (opaque.length % WORLD_QUAD_WORDS !== 0) throw new Error("World quad data must contain four words per face");

  const quadCount = opaque.length / WORLD_QUAD_WORDS;
  const stride = quadCount + 1;
  let packedQuadCount = 0;
  let referenceCount = 0;
  for (let offset = 0; offset < opaque.length; offset += WORLD_QUAD_WORDS) {
    const refs = packableReferenceCount(opaque, offset);
    if (refs > 0) {
      packedQuadCount += 1;
      referenceCount += refs;
      assertSafeSortKey(maxTileKey(opaque, offset) * stride + offset / WORLD_QUAD_WORDS);
    }
  }
  if (packedQuadCount === 0) return { opaque: opaque.slice(), surfaces: [] };

  const sorted = new Float64Array(referenceCount);
  const kept = new Uint32Array((quadCount - packedQuadCount) * WORLD_QUAD_WORDS);
  for (let offset = 0, packed = 0, keptOffset = 0; offset < opaque.length; offset += WORLD_QUAD_WORDS) {
    if (packableReferenceCount(opaque, offset) > 0) {
      const word0 = opaque[offset]!;
      const word1 = opaque[offset + 1]!;
      const face = (word1 >>> 20) & 0x7;
      const plane = word0 & COORD_MASK;
      const u0 = (word0 >>> 10) & COORD_MASK;
      const v0 = (word0 >>> 20) & COORD_MASK;
      const u1 = u0 + (word1 & COORD_MASK) - 1;
      const v1 = v0 + ((word1 >>> 10) & COORD_MASK) - 1;
      for (let tileU = Math.floor(u0 / TILE_SIZE); tileU <= Math.floor(u1 / TILE_SIZE); tileU += 1) {
        for (let tileV = Math.floor(v0 / TILE_SIZE); tileV <= Math.floor(v1 / TILE_SIZE); tileV += 1) {
          sorted[packed++] = tileKey(face, plane, tileU, tileV) * stride + offset / WORLD_QUAD_WORDS;
        }
      }
    } else {
      kept.set(opaque.subarray(offset, offset + WORLD_QUAD_WORDS), keptOffset);
      keptOffset += WORLD_QUAD_WORDS;
    }
  }
  sorted.sort();

  const surfaces: WorldSurfaceTilePage[] = [];
  const cells = new Uint32Array(TILE_SIZE * TILE_SIZE);
  const rows = new Uint32Array(TILE_SIZE);
  let pageTexels: Uint32Array | null = null;
  let pageQuads = new Uint32Array(1024 * WORLD_QUAD_WORDS);
  let pageUsed = 0;
  let pageQuadWords = 0;
  let previousKey = -1;
  let count = 0;
  let minU = TILE_SIZE;
  let minV = TILE_SIZE;
  let maxU = -1;
  let maxV = -1;

  const finishPage = () => {
    if (!pageTexels || pageQuadWords === 0) return;
    const height = Math.ceil(pageUsed / PAGE_WIDTH);
    const texelLength = height * PAGE_WIDTH;
    surfaces.push({
      quads: pageQuads.slice(0, pageQuadWords),
      texels: texelLength === pageTexels.length ? pageTexels : pageTexels.slice(0, texelLength),
      width: PAGE_WIDTH,
      height,
    });
    pageTexels = null;
    pageQuads = new Uint32Array(1024 * WORLD_QUAD_WORDS);
    pageUsed = 0;
    pageQuadWords = 0;
  };

  const appendQuad = (word0: number, word1: number, word2: number) => {
    if (pageQuadWords + WORLD_QUAD_WORDS > pageQuads.length) {
      const grown = new Uint32Array(pageQuads.length * 2);
      grown.set(pageQuads);
      pageQuads = grown;
    }
    pageQuads[pageQuadWords] = word0 >>> 0;
    pageQuads[pageQuadWords + 1] = word1 >>> 0;
    pageQuads[pageQuadWords + 2] = word2 >>> 0;
    pageQuads[pageQuadWords + 3] = 0;
    pageQuadWords += WORLD_QUAD_WORDS;
  };

  const finishTile = () => {
    if (count === 0) return;
    const width = maxU - minU + 1;
    const height = maxV - minV + 1;
    const wordCount = height + count;
    if (!pageTexels) pageTexels = new Uint32Array(PAGE_TEXELS);
    if (pageUsed + wordCount > PAGE_TEXELS) {
      finishPage();
      pageTexels = new Uint32Array(PAGE_TEXELS);
    }

    const key = previousKey;
    const tileV = key % TILE_AXIS;
    const tileU = Math.floor(key / TILE_AXIS) % TILE_AXIS;
    const planeFace = Math.floor(key / (TILE_AXIS * TILE_AXIS));
    const plane = planeFace % 1024;
    const face = Math.floor(planeFace / 1024);
    const u = tileU * TILE_SIZE + minU;
    const v = tileV * TILE_SIZE + minV;
    const texelOffset = pageUsed;
    const valuesOffset = texelOffset + height;
    let written = 0;
    for (let row = minV; row <= maxV; row += 1) {
      let mask = 0;
      const before = written;
      for (let col = minU; col <= maxU; col += 1) {
        if ((rows[row]! & (1 << col)) === 0) continue;
        const texel = cells[row * TILE_SIZE + col]!;
        mask |= 1 << (col - minU);
        pageTexels![valuesOffset + written] = texel;
        written += 1;
      }
      pageTexels![texelOffset + row - minV] = (before << 16) | mask;
    }
    if (written !== count) throw new Error("World surface tile row encoding mismatch");
    appendQuad(plane | (u << 10) | (v << 20), width | (height << 10) | (face << 20), texelOffset);
    pageUsed += wordCount;
    cells.fill(0);
    rows.fill(0);
    count = 0;
    minU = TILE_SIZE;
    minV = TILE_SIZE;
    maxU = -1;
    maxV = -1;
  };

  for (const encoded of sorted) {
    const key = Math.floor(encoded / stride);
    if (key !== previousKey) {
      finishTile();
      previousKey = key;
    }
    const offset = Math.trunc(encoded - key * stride) * WORLD_QUAD_WORDS;
    const texel = surfaceTexel(opaque[offset + 2]!, opaque[offset + 3]!);
    const tileV = key % TILE_AXIS;
    const tileU = Math.floor(key / TILE_AXIS) % TILE_AXIS;
    const word0 = opaque[offset]!;
    const word1 = opaque[offset + 1]!;
    const sourceU = (word0 >>> 10) & COORD_MASK;
    const sourceV = (word0 >>> 20) & COORD_MASK;
    const sourceMaxU = sourceU + (word1 & COORD_MASK) - 1;
    const sourceMaxV = sourceV + ((word1 >>> 10) & COORD_MASK) - 1;
    const localMinU = Math.max(sourceU, tileU * TILE_SIZE) - tileU * TILE_SIZE;
    const localMinV = Math.max(sourceV, tileV * TILE_SIZE) - tileV * TILE_SIZE;
    const localMaxU = Math.min(sourceMaxU, tileU * TILE_SIZE + TILE_SIZE - 1) - tileU * TILE_SIZE;
    const localMaxV = Math.min(sourceMaxV, tileV * TILE_SIZE + TILE_SIZE - 1) - tileV * TILE_SIZE;
    paintCells(localMinU, localMinV, localMaxU, localMaxV, texel);
  }
  finishTile();
  finishPage();

  return { opaque: kept.length ? kept : null, surfaces };

  function paintCells(localMinU: number, localMinV: number, localMaxU: number, localMaxV: number, texel: number): void {
    for (let row = localMinV; row <= localMaxV; row += 1) {
      for (let col = localMinU; col <= localMaxU; col += 1) {
        const cellOffset = row * TILE_SIZE + col;
        const bit = 1 << col;
        if ((rows[row]! & bit) !== 0) throw new Error("Duplicate world surface tile cell");
        rows[row] = (rows[row]! | bit) >>> 0;
        cells[cellOffset] = texel;
        count += 1;
      }
    }
    if (localMinU < minU) minU = localMinU;
    if (localMinV < minV) minV = localMinV;
    if (localMaxU > maxU) maxU = localMaxU;
    if (localMaxV > maxV) maxV = localMaxV;
  }
}

function packableReferenceCount(words: Uint32Array, offset: number): number {
  const word0 = words[offset]!;
  const word1 = words[offset + 1]!;
  const word2 = words[offset + 2]!;
  const word3 = words[offset + 3]!;
  if (
    (word0 & 0xc0000000) === 0 &&
    (word1 & 0xff800000) === 0 &&
    ((word1 >>> 20) & 0x7) <= 5 &&
    (word2 & 0xffff) <= COORD_MASK &&
    (word2 >>> 16) <= COORD_MASK &&
    (word3 & ~PACKED_FLAG_MASK) === 0
  ) {
    const width = word1 & COORD_MASK;
    const height = (word1 >>> 10) & COORD_MASK;
    const area = width * height;
    const u = (word0 >>> 10) & COORD_MASK;
    const v = (word0 >>> 20) & COORD_MASK;
    if (width === 0 || height === 0 || u + width > 1024 || v + height > 1024) return 0;
    if ((word1 & 0xfffff) !== UNIT_DIMENSIONS && (area > TILE_SIZE || !hasFlatAo(word3))) return 0;
    return (
      (Math.floor((u + width - 1) / TILE_SIZE) - Math.floor(u / TILE_SIZE) + 1) *
      (Math.floor((v + height - 1) / TILE_SIZE) - Math.floor(v / TILE_SIZE) + 1)
    );
  }
  return 0;
}

function maxTileKey(words: Uint32Array, offset: number): number {
  const word0 = words[offset]!;
  const word1 = words[offset + 1]!;
  const face = (word1 >>> 20) & 0x7;
  const plane = word0 & COORD_MASK;
  const u = (word0 >>> 10) & COORD_MASK;
  const v = (word0 >>> 20) & COORD_MASK;
  return tileKey(
    face,
    plane,
    Math.floor((u + (word1 & COORD_MASK) - 1) / TILE_SIZE),
    Math.floor((v + ((word1 >>> 10) & COORD_MASK) - 1) / TILE_SIZE),
  );
}

function tileKey(face: number, plane: number, tileU: number, tileV: number): number {
  return ((face * 1024 + plane) * TILE_AXIS + tileU) * TILE_AXIS + tileV;
}

function hasFlatAo(word3: number): boolean {
  const ao = (word3 >>> 2) & 0xff;
  const level = ao & 0x3;
  return ((ao >>> 2) & 0x3) === level && ((ao >>> 4) & 0x3) === level && ((ao >>> 6) & 0x3) === level;
}

function assertSafeSortKey(encoded: number): void {
  if (!Number.isSafeInteger(encoded)) throw new Error("World surface tile batch is too large to sort safely");
}

function surfaceTexel(word2: number, word3: number): number {
  return ((word2 & COORD_MASK) | (((word2 >>> 16) & COORD_MASK) << 10) | ((word3 & PACKED_FLAG_MASK) << 20)) >>> 0;
}
