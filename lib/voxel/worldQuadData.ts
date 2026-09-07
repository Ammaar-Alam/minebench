export type WorldQuadBucketName = "opaque" | "cutout" | "transparent" | "water" | "emissive";
export type WorldQuadTintIndex = 0 | 1 | 2 | 3;
export type WorldQuadAnchor = [number, number, number];

export type WorldQuadPayload = {
  anchor: WorldQuadAnchor;
  opaque: Uint32Array | null;
  cutout: Uint32Array | null;
  transparent: Uint32Array | null;
  water: Uint32Array | null;
  emissive: Uint32Array | null;
};

export type WorldQuadBucket = {
  words: Uint32Array;
  wordCount: number;
};

export const WORLD_QUAD_WORDS = 4;
export const WORLD_QUAD_FIELD_MAX = 1023;
export const WORLD_QUAD_TINT_WHITE: WorldQuadTintIndex = 0;
export const WORLD_QUAD_TINT_LEAVES: WorldQuadTintIndex = 1;
export const WORLD_QUAD_TINT_GRASS: WorldQuadTintIndex = 2;
export const WORLD_QUAD_TINT_WATER: WorldQuadTintIndex = 3;
export const WORLD_QUAD_AO_LEVELS = [0.58, 0.72, 0.86, 1] as const;

const INITIAL_QUADS = 512;
const COLOR_UNIT = 255;
const EMPTY_WORDS = new Uint32Array(0);

type Tint = readonly [number, number, number];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function srgbByteToLinear(byte: number): number {
  const s = Math.min(1, Math.max(0, byte / 255));
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function hexToLinearRgb(hex: number): Tint {
  return [
    srgbByteToLinear((hex >> 16) & 0xff),
    srgbByteToLinear((hex >> 8) & 0xff),
    srgbByteToLinear(hex & 0xff),
  ];
}

export const WORLD_QUAD_TINTS: readonly Tint[] = [
  [1, 1, 1],
  hexToLinearRgb(0x48b518),
  hexToLinearRgb(0x7fb238),
  hexToLinearRgb(0x3f76e4),
];

function colorByte(tintIndex: WorldQuadTintIndex, aoLevel: number, channel: 0 | 1 | 2): number {
  return Math.round(clamp01(WORLD_QUAD_TINTS[tintIndex]![channel] * WORLD_QUAD_AO_LEVELS[aoLevel]!) * COLOR_UNIT);
}

function buildWorldQuadColors(): Float32Array {
  const colors = new Float32Array(WORLD_QUAD_TINTS.length * WORLD_QUAD_AO_LEVELS.length * 3);
  for (let tintIndex = 0; tintIndex < WORLD_QUAD_TINTS.length; tintIndex += 1) {
    for (let aoLevel = 0; aoLevel < WORLD_QUAD_AO_LEVELS.length; aoLevel += 1) {
      const offset = (tintIndex * WORLD_QUAD_AO_LEVELS.length + aoLevel) * 3;
      colors[offset] = colorByte(tintIndex as WorldQuadTintIndex, aoLevel, 0) / COLOR_UNIT;
      colors[offset + 1] = colorByte(tintIndex as WorldQuadTintIndex, aoLevel, 1) / COLOR_UNIT;
      colors[offset + 2] = colorByte(tintIndex as WorldQuadTintIndex, aoLevel, 2) / COLOR_UNIT;
    }
  }
  return colors;
}

export const WORLD_QUAD_COLORS = buildWorldQuadColors();

function buildWorldQuadLuminance(): Uint16Array {
  const luminance = new Uint16Array(WORLD_QUAD_TINTS.length * WORLD_QUAD_AO_LEVELS.length);
  for (let tintIndex = 0; tintIndex < WORLD_QUAD_TINTS.length; tintIndex += 1) {
    for (let aoLevel = 0; aoLevel < WORLD_QUAD_AO_LEVELS.length; aoLevel += 1) {
      const offset = tintIndex * WORLD_QUAD_AO_LEVELS.length + aoLevel;
      luminance[offset] =
        colorByte(tintIndex as WorldQuadTintIndex, aoLevel, 0) +
        colorByte(tintIndex as WorldQuadTintIndex, aoLevel, 1) +
        colorByte(tintIndex as WorldQuadTintIndex, aoLevel, 2);
    }
  }
  return luminance;
}

const WORLD_QUAD_LUMINANCE = buildWorldQuadLuminance();

export function createWorldQuadBucket(): WorldQuadBucket {
  return { words: new Uint32Array(INITIAL_QUADS * WORLD_QUAD_WORDS), wordCount: 0 };
}

function ensureWorldQuadCapacity(bucket: WorldQuadBucket, extraWords: number): void {
  const needed = bucket.wordCount + extraWords;
  if (needed <= bucket.words.length) return;
  let nextLength = Math.max(bucket.words.length, WORLD_QUAD_WORDS);
  while (nextLength < needed) nextLength *= 2;
  const grown = new Uint32Array(nextLength);
  grown.set(bucket.words.subarray(0, bucket.wordCount));
  bucket.words = grown;
}

export function appendWorldQuad(bucket: WorldQuadBucket, word0: number, word1: number, word2: number, word3: number): void {
  ensureWorldQuadCapacity(bucket, WORLD_QUAD_WORDS);
  const offset = bucket.wordCount;
  bucket.words[offset] = word0 >>> 0;
  bucket.words[offset + 1] = word1 >>> 0;
  bucket.words[offset + 2] = word2 >>> 0;
  bucket.words[offset + 3] = word3 >>> 0;
  bucket.wordCount += WORLD_QUAD_WORDS;
}

export function serializeWorldQuadBucket(bucket: WorldQuadBucket): Uint32Array | null {
  if (bucket.wordCount === 0) return null;
  const words = bucket.words.length === bucket.wordCount
    ? bucket.words
    : bucket.words.slice(0, bucket.wordCount);
  bucket.words = EMPTY_WORDS;
  bucket.wordCount = 0;
  return words;
}

export function worldQuadAoLevel(value: number): 0 | 1 | 2 | 3 {
  return Math.max(0, Math.min(3, Math.round((value - 0.58) / 0.14))) as 0 | 1 | 2 | 3;
}

export function packWorldQuadAo(ambientOcclusion?: readonly [number, number, number, number]): number {
  let packed = 0;
  for (let corner = 0; corner < 4; corner += 1) {
    const level = ambientOcclusion ? worldQuadAoLevel(ambientOcclusion[corner]!) : 3;
    packed |= level << (corner * 2);
  }
  return packed;
}

export function worldQuadFlipDiagonal(tintIndex: WorldQuadTintIndex, packedAoByte: number): 0 | 1 {
  const offset = tintIndex * WORLD_QUAD_AO_LEVELS.length;
  const l0 = WORLD_QUAD_LUMINANCE[offset + (packedAoByte & 0x3)]!;
  const l1 = WORLD_QUAD_LUMINANCE[offset + ((packedAoByte >> 2) & 0x3)]!;
  const l2 = WORLD_QUAD_LUMINANCE[offset + ((packedAoByte >> 4) & 0x3)]!;
  const l3 = WORLD_QUAD_LUMINANCE[offset + ((packedAoByte >> 6) & 0x3)]!;
  return l0 + l2 < l1 + l3 ? 1 : 0;
}
