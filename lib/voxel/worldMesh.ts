import { ATLAS } from "@/lib/blocks/atlas";
import type { SerializedBuildBounds, VoxelMeshPayload } from "@/lib/voxel/mesh";
import {
  WORLD_QUAD_WORDS,
  type WorldQuadBucketName,
  type WorldQuadPayload,
} from "@/lib/voxel/worldQuadData";
import type { WorldSurfaceTilePage } from "@/lib/voxel/worldSurfaceTiles";

const MAGIC_V1 = 0x4d425131; // MBQ1
const MAGIC_V2 = 0x4d425132; // MBQ2
const LEGACY_RENDERER_VERSION = "v1";
const RENDERER_VERSION = "v2";
const HEADER_BYTES = 8;
const MAX_METADATA_BYTES = 16 * 1024;
const SURFACE_PAGE_WIDTH = 2048;
const MAX_SURFACE_PAGE_HEIGHT = 2048;
const MAX_BODY_WORDS = Math.floor(Number.MAX_SAFE_INTEGER / 4);
const COORD_MASK = 0x3ff;
const BUCKET_NAMES = ["opaque", "cutout", "transparent", "water", "emissive"] as const;
const EPSILON = 1e-6;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

type Vec3 = [number, number, number];
type RendererVersion = typeof LEGACY_RENDERER_VERSION | typeof RENDERER_VERSION;
type BucketWordLengths = Record<WorldQuadBucketName, number>;
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
type RawMeshBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};
type WorldMeshMetadata = {
  rendererVersion: RendererVersion;
  anchor: Vec3;
  bounds: SerializedBuildBounds;
  filteredBlockCount: number;
  bucketWordLengths: BucketWordLengths;
  surfacePages: SurfacePageMetadata[];
  transparentDepth?: TransparentDepthMetadata;
};

let versionPromise: Promise<string> | null = null;
let atlasHashPromise: Promise<string> | null = null;
let atlasWords: Set<number> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertWorldMesh(condition: unknown, message: string): asserts condition {
  if (!condition) throw invalidWorldMesh(message);
}

function invalidWorldMesh(message: string): never {
  throw new Error(`Invalid world mesh payload: ${message}`);
}

function paddedLength(length: number): number {
  return length + ((4 - (length % 4)) % 4);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getAtlasHash(): Promise<string> {
  atlasHashPromise ??= crypto.subtle
    .digest("SHA-256", ENCODER.encode(JSON.stringify(ATLAS)))
    .then((digest) => hex(new Uint8Array(digest)));
  return atlasHashPromise;
}

export function getWorldMeshVersion(): Promise<string> {
  versionPromise ??= getAtlasHash().then((hash) => `${RENDERER_VERSION}-${hash}`);
  return versionPromise;
}

export async function isWorldMeshVersionSupported(version: string): Promise<boolean> {
  const atlasHash = await getAtlasHash();
  return version === `${RENDERER_VERSION}-${atlasHash}` || version === `${LEGACY_RENDERER_VERSION}-${atlasHash}`;
}

function atlasWordSet(): Set<number> {
  if (atlasWords) return atlasWords;
  atlasWords = new Set();
  for (const entry of Object.values(ATLAS.keys)) {
    const u0 = entry.x;
    const v0 = ATLAS.atlasHeight - entry.y - entry.h;
    if (
      Number.isInteger(u0) &&
      Number.isInteger(v0) &&
      u0 >= 0 &&
      v0 >= 0 &&
      u0 <= 0xffff &&
      v0 <= 0xffff
    ) {
      atlasWords.add((u0 | (v0 << 16)) >>> 0);
    }
  }
  return atlasWords;
}

function readFiniteVec3(value: unknown, label: string): Vec3 {
  assertWorldMesh(Array.isArray(value) && value.length === 3, `${label} must have three values`);
  const x = value[0];
  const y = value[1];
  const z = value[2];
  assertWorldMesh(typeof x === "number" && Number.isFinite(x), `${label} must be finite`);
  assertWorldMesh(typeof y === "number" && Number.isFinite(y), `${label} must be finite`);
  assertWorldMesh(typeof z === "number" && Number.isFinite(z), `${label} must be finite`);
  return [x, y, z];
}

function assertNonNegativeSafeInt(value: unknown, label: string): asserts value is number {
  assertWorldMesh(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer`,
  );
}

function assertPositiveSafeInt(value: unknown, label: string): asserts value is number {
  assertWorldMesh(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    `${label} must be a positive safe integer`,
  );
}

function readBounds(value: unknown): SerializedBuildBounds {
  assertWorldMesh(isRecord(value), "bounds must be an object");
  const radius = value.radius;
  assertWorldMesh(typeof radius === "number" && Number.isFinite(radius) && radius > 0, "bounds.radius must be positive");
  const bounds = {
    min: readFiniteVec3(value.min, "bounds.min"),
    max: readFiniteVec3(value.max, "bounds.max"),
    center: readFiniteVec3(value.center, "bounds.center"),
    radius,
  };
  for (let axis = 0; axis < 3; axis += 1) {
    assertWorldMesh(bounds.max[axis] >= bounds.min[axis], "bounds max must be greater than min");
    const expectedCenter = (bounds.min[axis] + bounds.max[axis]) / 2;
    assertWorldMesh(Math.abs(bounds.center[axis] - expectedCenter) <= EPSILON, "bounds center is inconsistent");
  }
  const expectedRadius = Math.hypot(
    bounds.max[0] - bounds.center[0],
    bounds.max[1] - bounds.center[1],
    bounds.max[2] - bounds.center[2],
  );
  assertWorldMesh(bounds.radius + EPSILON >= expectedRadius, "bounds radius is inconsistent");
  return bounds;
}

function readBucketWordLengths(value: unknown): BucketWordLengths {
  assertWorldMesh(isRecord(value), "bucket lengths must be an object");
  const lengths = {} as BucketWordLengths;
  for (const name of BUCKET_NAMES) {
    const length = value[name];
    assertNonNegativeSafeInt(length, `${name} word length`);
    assertWorldMesh(length % WORLD_QUAD_WORDS === 0, `${name} word length must align to quads`);
    lengths[name] = length;
  }
  return lengths;
}

function readSurfacePageMetadata(value: unknown): SurfacePageMetadata[] {
  assertWorldMesh(Array.isArray(value), "surface pages must be an array");
  return value.map((page, index) => {
    assertWorldMesh(isRecord(page), `surface page ${index} must be an object`);
    const width = page.width;
    const height = page.height;
    const quadWordLength = page.quadWordLength;
    const texelWordLength = page.texelWordLength;
    assertPositiveSafeInt(width, `surface page ${index} width`);
    assertPositiveSafeInt(height, `surface page ${index} height`);
    assertPositiveSafeInt(quadWordLength, `surface page ${index} quad word length`);
    assertPositiveSafeInt(texelWordLength, `surface page ${index} texel word length`);
    assertWorldMesh(width === SURFACE_PAGE_WIDTH, `surface page ${index} width is unsupported`);
    assertWorldMesh(height <= MAX_SURFACE_PAGE_HEIGHT, `surface page ${index} height is unsupported`);
    assertWorldMesh(quadWordLength % WORLD_QUAD_WORDS === 0, `surface page ${index} quad word length must align to quads`);
    assertWorldMesh(texelWordLength === width * height, `surface page ${index} texel word length is inconsistent`);
    return { quadWordLength, texelWordLength, width, height };
  });
}

function readTransparentDepthMetadata(value: unknown): TransparentDepthMetadata | undefined {
  if (value === undefined) return undefined;
  assertWorldMesh(isRecord(value), "transparent depth must be an object");
  const quadWordLength = value.quadWordLength;
  assertNonNegativeSafeInt(quadWordLength, "transparent depth quad word length");
  assertWorldMesh(quadWordLength % WORLD_QUAD_WORDS === 0, "transparent depth quad word length must align to quads");
  const surfacePages = readSurfacePageMetadata(value.surfacePages);
  assertWorldMesh(surfacePages.length > 0, "transparent depth surface pages are required");
  return { quadWordLength, surfacePages };
}

function readMetadata(value: unknown, rendererVersion: RendererVersion): WorldMeshMetadata {
  assertWorldMesh(isRecord(value), "metadata must be an object");
  assertWorldMesh(value.rendererVersion === rendererVersion, "renderer version does not match payload magic");
  const filteredBlockCount = value.filteredBlockCount;
  assertNonNegativeSafeInt(filteredBlockCount, "filteredBlockCount");
  return {
    rendererVersion,
    anchor: readFiniteVec3(value.anchor, "anchor"),
    bounds: readBounds(value.bounds),
    filteredBlockCount,
    bucketWordLengths: readBucketWordLengths(value.bucketWordLengths),
    surfacePages: rendererVersion === RENDERER_VERSION ? readSurfacePageMetadata(value.surfacePages) : [],
    transparentDepth: rendererVersion === RENDERER_VERSION ? readTransparentDepthMetadata(value.transparentDepth) : undefined,
  };
}

function rawBounds(metadata: Pick<WorldMeshMetadata, "anchor" | "bounds">) {
  return {
    minX: metadata.bounds.min[0] + metadata.anchor[0],
    minY: metadata.bounds.min[1] + metadata.anchor[1],
    minZ: metadata.bounds.min[2] + metadata.anchor[2],
    maxX: metadata.bounds.max[0] + metadata.anchor[0],
    maxY: metadata.bounds.max[1] + metadata.anchor[1],
    maxZ: metadata.bounds.max[2] + metadata.anchor[2],
  };
}

function validateQuadBounds(
  bucket: WorldQuadBucketName,
  bounds: RawMeshBounds,
  direction: number,
  plane: number,
  u: number,
  v: number,
  width: number,
  height: number,
): void {
  let minX: number;
  let minY: number;
  let minZ: number;
  let maxX: number;
  let maxY: number;
  let maxZ: number;
  if (direction < 2) {
    minX = plane;
    maxX = plane;
    if (bucket === "water") {
      minY = u;
      maxY = u + width;
      minZ = v;
      maxZ = v + height;
    } else {
      minY = v;
      maxY = v + height;
      minZ = u;
      maxZ = u + width;
    }
  } else if (direction < 4) {
    minX = u;
    maxX = u + width;
    minY = v;
    maxY = v + height;
    minZ = plane;
    maxZ = plane;
  } else {
    minX = u;
    maxX = u + width;
    minY = plane;
    maxY = plane;
    minZ = v;
    maxZ = v + height;
  }

  if (
    minX + EPSILON < bounds.minX ||
    minY + EPSILON < bounds.minY ||
    minZ + EPSILON < bounds.minZ ||
    maxX > bounds.maxX + EPSILON ||
    maxY > bounds.maxY + EPSILON ||
    maxZ > bounds.maxZ + EPSILON
  ) {
    invalidWorldMesh(`${bucket} quad exceeds declared bounds`);
  }
}

function validateBucket(
  bucket: WorldQuadBucketName,
  words: Uint32Array | null,
  bounds: RawMeshBounds,
): void {
  if (!words) return;
  assertWorldMesh(words.length % WORLD_QUAD_WORDS === 0, `${bucket} word length must align to quads`);
  const validAtlasWords = atlasWordSet();
  for (let offset = 0; offset < words.length; offset += WORLD_QUAD_WORDS) {
    const word0 = words[offset]!;
    const word1 = words[offset + 1]!;
    const atlasWord = words[offset + 2]!;
    const word3 = words[offset + 3]!;
    if ((word0 & 0xc0000000) !== 0) invalidWorldMesh(`${bucket} quad has unsupported coordinate bits`);
    if ((word1 & 0xff800000) !== 0) invalidWorldMesh(`${bucket} quad has unsupported size bits`);
    if ((word3 & 0xfffff800) !== 0) invalidWorldMesh(`${bucket} quad has unsupported color bits`);

    const plane = word0 & COORD_MASK;
    const u = (word0 >>> 10) & COORD_MASK;
    const v = (word0 >>> 20) & COORD_MASK;
    const width = word1 & COORD_MASK;
    const height = (word1 >>> 10) & COORD_MASK;
    const direction = (word1 >>> 20) & 0x7;
    if (direction > 5) invalidWorldMesh(`${bucket} quad direction is invalid`);
    if (width === 0 || height === 0) invalidWorldMesh(`${bucket} quad extent must be nonzero`);
    if (bucket === "water") {
      if (atlasWord !== 0) invalidWorldMesh("water quad atlas word is invalid");
    } else if (!validAtlasWords.has(atlasWord)) {
      invalidWorldMesh(`${bucket} quad atlas word is invalid`);
    }
    validateQuadBounds(bucket, bounds, direction, plane, u, v, width, height);
  }
}

function popcount16(value: number): number {
  value -= (value >>> 1) & 0x5555;
  value = (value & 0x3333) + ((value >>> 2) & 0x3333);
  return ((((value + (value >>> 4)) & 0x0f0f) * 0x0101) >>> 8) & 0xff;
}

function validateSurfacePage(page: WorldSurfaceTilePage, bounds: RawMeshBounds, pageIndex: number): void {
  assertWorldMesh(page.quads.length % WORLD_QUAD_WORDS === 0, `surface page ${pageIndex} quad word length must align to quads`);
  assertWorldMesh(page.quads.length > 0, `surface page ${pageIndex} must contain quads`);
  assertWorldMesh(page.width === SURFACE_PAGE_WIDTH, `surface page ${pageIndex} width is unsupported`);
  assertWorldMesh(
    Number.isSafeInteger(page.height) && page.height > 0 && page.height <= MAX_SURFACE_PAGE_HEIGHT,
    `surface page ${pageIndex} height is unsupported`,
  );
  assertWorldMesh(page.texels.length === page.width * page.height, `surface page ${pageIndex} texel word length is inconsistent`);

  const validAtlasWords = atlasWordSet();
  let nextTexelOffset = 0;
  for (let offset = 0; offset < page.quads.length; offset += WORLD_QUAD_WORDS) {
    const word0 = page.quads[offset]!;
    const word1 = page.quads[offset + 1]!;
    const texelOffset = page.quads[offset + 2]!;
    const word3 = page.quads[offset + 3]!;
    if ((word0 & 0xc0000000) !== 0) invalidWorldMesh(`surface page ${pageIndex} quad has unsupported coordinate bits`);
    if ((word1 & 0xff800000) !== 0) invalidWorldMesh(`surface page ${pageIndex} quad has unsupported size bits`);
    if (word3 !== 0) invalidWorldMesh(`surface page ${pageIndex} quad has unsupported reserved bits`);

    const plane = word0 & COORD_MASK;
    const u = (word0 >>> 10) & COORD_MASK;
    const v = (word0 >>> 20) & COORD_MASK;
    const width = word1 & COORD_MASK;
    const height = (word1 >>> 10) & COORD_MASK;
    const direction = (word1 >>> 20) & 0x7;
    if (direction > 5) invalidWorldMesh(`surface page ${pageIndex} quad direction is invalid`);
    if (width === 0 || width > 16 || height === 0 || height > 16) {
      invalidWorldMesh(`surface page ${pageIndex} quad extent is invalid`);
    }
    if (u + width > 1024 || v + height > 1024) invalidWorldMesh(`surface page ${pageIndex} quad exceeds packed bounds`);
    if (texelOffset !== nextTexelOffset) invalidWorldMesh(`surface page ${pageIndex} texel offsets are not contiguous`);
    validateQuadBounds("opaque", bounds, direction, plane, u, v, width, height);

    let occupiedCells = 0;
    const valueOffset = texelOffset + height;
    assertWorldMesh(valueOffset <= page.texels.length, `surface page ${pageIndex} texel data is out of bounds`);
    for (let row = 0; row < height; row += 1) {
      const header = page.texels[texelOffset + row]!;
      const mask = header & 0xffff;
      assertWorldMesh(header >>> 16 === occupiedCells, `surface page ${pageIndex} row prefix is invalid`);
      assertWorldMesh(width === 16 || (mask >>> width) === 0, `surface page ${pageIndex} row mask exceeds width`);
      const rowCells = popcount16(mask);
      assertWorldMesh(valueOffset + occupiedCells + rowCells <= page.texels.length, `surface page ${pageIndex} cell data is out of bounds`);
      for (let cell = 0; cell < rowCells; cell += 1) {
        const cellWord = page.texels[valueOffset + occupiedCells + cell]!;
        if ((cellWord & 0x80000000) !== 0) invalidWorldMesh(`surface page ${pageIndex} cell has unsupported reserved bits`);
        const atlasWord = ((cellWord & COORD_MASK) | (((cellWord >>> 10) & COORD_MASK) << 16)) >>> 0;
        if (!validAtlasWords.has(atlasWord)) invalidWorldMesh(`surface page ${pageIndex} cell atlas word is invalid`);
      }
      occupiedCells += rowCells;
    }
    assertWorldMesh(occupiedCells > 0, `surface page ${pageIndex} quad has no occupied cells`);
    nextTexelOffset = valueOffset + occupiedCells;
  }

  assertWorldMesh(page.texels.length - nextTexelOffset < page.width, `surface page ${pageIndex} padding is too large`);
  for (let offset = nextTexelOffset; offset < page.texels.length; offset += 1) {
    assertWorldMesh(page.texels[offset] === 0, `surface page ${pageIndex} padding must be zero`);
  }
}

function validateSurfacePages(pages: readonly WorldSurfaceTilePage[], bounds: RawMeshBounds): void {
  for (let index = 0; index < pages.length; index += 1) validateSurfacePage(pages[index]!, bounds, index);
}

function assertCompactPayload(payload: VoxelMeshPayload): asserts payload is VoxelMeshPayload & { worldQuads: WorldQuadPayload } {
  assertWorldMesh(payload.opaque === null, "opaque legacy bucket must be null");
  assertWorldMesh(payload.cutout === null, "cutout legacy bucket must be null");
  assertWorldMesh(payload.transparent === null, "transparent legacy bucket must be null");
  assertWorldMesh(payload.water === null, "water legacy bucket must be null");
  assertWorldMesh(payload.emissive === null, "emissive legacy bucket must be null");
  assertWorldMesh(Boolean(payload.worldQuads), "worldQuads are required");
}

function metadataForPayload(payload: VoxelMeshPayload & { worldQuads: WorldQuadPayload }): WorldMeshMetadata {
  const surfaces = payload.worldQuads.surfaces ?? [];
  const transparentDepth = payload.worldQuads.transparentDepth;
  const metadata = readMetadata({
    rendererVersion: RENDERER_VERSION,
    anchor: payload.worldQuads.anchor,
    bounds: payload.bounds,
    filteredBlockCount: payload.filteredBlockCount,
    bucketWordLengths: Object.fromEntries(
      BUCKET_NAMES.map((name) => [name, payload.worldQuads[name]?.length ?? 0]),
    ),
    surfacePages: surfaces.map((page) => ({
      quadWordLength: page.quads.length,
      texelWordLength: page.texels.length,
      width: page.width,
      height: page.height,
    })),
    transparentDepth: transparentDepth ? {
      quadWordLength: transparentDepth.quads?.length ?? 0,
      surfacePages: transparentDepth.surfaces.map((page) => ({
        quadWordLength: page.quads.length,
        texelWordLength: page.texels.length,
        width: page.width,
        height: page.height,
      })),
    } : undefined,
  }, RENDERER_VERSION);
  const bounds = rawBounds(metadata);
  for (const name of BUCKET_NAMES) validateBucket(name, payload.worldQuads[name], bounds);
  validateSurfacePages(surfaces, bounds);
  if (transparentDepth) {
    assertWorldMesh(
      payload.worldQuads.transparent !== null && payload.worldQuads.transparent.length > 0,
      "transparent depth requires transparent quads",
    );
    validateBucket("transparent", transparentDepth.quads, bounds);
    validateSurfacePages(transparentDepth.surfaces, bounds);
  }
  return metadata;
}

function encodeMetadata(metadata: WorldMeshMetadata): Uint8Array {
  const raw = ENCODER.encode(JSON.stringify(metadata));
  const length = paddedLength(raw.length);
  assertWorldMesh(length > 0 && length <= MAX_METADATA_BYTES, "metadata header is too large");
  const bytes = new Uint8Array(length);
  bytes.fill(0x20);
  bytes.set(raw);
  return bytes;
}

function addWordLength(total: number, length: number, label: string): number {
  assertWorldMesh(total <= MAX_BODY_WORDS - length, `${label} lengths overflow`);
  return total + length;
}

function totalBodyWords(metadata: WorldMeshMetadata): number {
  let total = 0;
  for (const name of BUCKET_NAMES) total = addWordLength(total, metadata.bucketWordLengths[name], "bucket");
  for (let index = 0; index < metadata.surfacePages.length; index += 1) {
    const page = metadata.surfacePages[index]!;
    total = addWordLength(total, page.quadWordLength, `surface page ${index}`);
    total = addWordLength(total, page.texelWordLength, `surface page ${index}`);
  }
  if (metadata.transparentDepth) {
    total = addWordLength(total, metadata.transparentDepth.quadWordLength, "transparent depth");
    for (let index = 0; index < metadata.transparentDepth.surfacePages.length; index += 1) {
      const page = metadata.transparentDepth.surfacePages[index]!;
      total = addWordLength(total, page.quadWordLength, `transparent depth surface page ${index}`);
      total = addWordLength(total, page.texelWordLength, `transparent depth surface page ${index}`);
    }
  }
  return total;
}

function wordLengthBytes(wordLength: number, label: string): number {
  assertWorldMesh(wordLength <= MAX_BODY_WORDS, `${label} byte length overflow`);
  return wordLength * 4;
}

export function encodeWorldMeshPayload(payload: VoxelMeshPayload): Uint8Array {
  assertCompactPayload(payload);
  const metadata = metadataForPayload(payload);
  const metadataBytes = encodeMetadata(metadata);
  const bodyBytes = wordLengthBytes(totalBodyWords(metadata), "body");
  assertWorldMesh(bodyBytes <= Number.MAX_SAFE_INTEGER - HEADER_BYTES - metadataBytes.byteLength, "payload byte length overflow");
  const totalBytes = HEADER_BYTES + metadataBytes.byteLength + bodyBytes;
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC_V2, false);
  view.setUint32(4, metadataBytes.byteLength, false);
  bytes.set(metadataBytes, HEADER_BYTES);

  let offset = HEADER_BYTES + metadataBytes.byteLength;
  for (const name of BUCKET_NAMES) {
    const words = payload.worldQuads[name];
    if (!words) continue;
    bytes.set(new Uint8Array(words.buffer, words.byteOffset, words.byteLength), offset);
    offset += words.byteLength;
  }
  for (const page of payload.worldQuads.surfaces ?? []) {
    bytes.set(new Uint8Array(page.quads.buffer, page.quads.byteOffset, page.quads.byteLength), offset);
    offset += page.quads.byteLength;
    bytes.set(new Uint8Array(page.texels.buffer, page.texels.byteOffset, page.texels.byteLength), offset);
    offset += page.texels.byteLength;
  }
  if (payload.worldQuads.transparentDepth) {
    const quads = payload.worldQuads.transparentDepth.quads;
    if (quads) {
      bytes.set(new Uint8Array(quads.buffer, quads.byteOffset, quads.byteLength), offset);
      offset += quads.byteLength;
    }
    for (const page of payload.worldQuads.transparentDepth.surfaces) {
      bytes.set(new Uint8Array(page.quads.buffer, page.quads.byteOffset, page.quads.byteLength), offset);
      offset += page.quads.byteLength;
      bytes.set(new Uint8Array(page.texels.buffer, page.texels.byteOffset, page.texels.byteLength), offset);
      offset += page.texels.byteLength;
    }
  }
  return bytes;
}

function readUint32Words(bytes: Uint8Array, offset: number, wordLength: number): Uint32Array {
  const byteLength = wordLength * 4;
  if ((bytes.byteOffset + offset) % 4 === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset + offset, wordLength);
  }
  const copy = bytes.slice(offset, offset + byteLength);
  return new Uint32Array(copy.buffer, copy.byteOffset, wordLength);
}

function readUint32Bucket(bytes: Uint8Array, offset: number, wordLength: number): Uint32Array | null {
  return wordLength === 0 ? null : readUint32Words(bytes, offset, wordLength);
}

export function decodeWorldMeshPayload(bytes: Uint8Array): VoxelMeshPayload {
  assertWorldMesh(bytes.byteLength >= HEADER_BYTES, "header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  let rendererVersion: RendererVersion;
  if (magic === MAGIC_V1) rendererVersion = LEGACY_RENDERER_VERSION;
  else if (magic === MAGIC_V2) rendererVersion = RENDERER_VERSION;
  else invalidWorldMesh("magic is unsupported");
  const metadataLength = view.getUint32(4, false);
  assertWorldMesh(
    metadataLength > 0 &&
      metadataLength <= MAX_METADATA_BYTES &&
      metadataLength % 4 === 0,
    "metadata header length is invalid",
  );
  assertWorldMesh(HEADER_BYTES + metadataLength <= bytes.byteLength, "metadata header is truncated");

  let metadataJson: unknown;
  try {
    metadataJson = JSON.parse(DECODER.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength)));
  } catch {
    throw new Error("Invalid world mesh payload: metadata header is not JSON");
  }
  const metadata = readMetadata(metadataJson, rendererVersion);
  const bounds = rawBounds(metadata);
  const bodyOffset = HEADER_BYTES + metadataLength;
  const bodyBytes = wordLengthBytes(totalBodyWords(metadata), "body");
  assertWorldMesh(bodyOffset <= Number.MAX_SAFE_INTEGER - bodyBytes, "body byte length overflow");
  assertWorldMesh(bodyOffset + bodyBytes === bytes.byteLength, "body byte length mismatch");

  const worldQuads = { anchor: metadata.anchor } as WorldQuadPayload;
  let offset = bodyOffset;
  for (const name of BUCKET_NAMES) {
    const words = readUint32Bucket(bytes, offset, metadata.bucketWordLengths[name]);
    validateBucket(name, words, bounds);
    worldQuads[name] = words;
    offset += metadata.bucketWordLengths[name] * 4;
  }
  if (metadata.surfacePages.length > 0) {
    const surfaces: WorldSurfaceTilePage[] = [];
    for (const pageMetadata of metadata.surfacePages) {
      const quads = readUint32Words(bytes, offset, pageMetadata.quadWordLength);
      offset += pageMetadata.quadWordLength * 4;
      const texels = readUint32Words(bytes, offset, pageMetadata.texelWordLength);
      offset += pageMetadata.texelWordLength * 4;
      surfaces.push({ quads, texels, width: pageMetadata.width, height: pageMetadata.height });
    }
    validateSurfacePages(surfaces, bounds);
    worldQuads.surfaces = surfaces;
  }
  if (metadata.transparentDepth) {
    assertWorldMesh(
      worldQuads.transparent !== null && worldQuads.transparent.length > 0,
      "transparent depth requires transparent quads",
    );
    const quads = readUint32Bucket(bytes, offset, metadata.transparentDepth.quadWordLength);
    validateBucket("transparent", quads, bounds);
    offset += metadata.transparentDepth.quadWordLength * 4;
    const surfaces: WorldSurfaceTilePage[] = [];
    for (const pageMetadata of metadata.transparentDepth.surfacePages) {
      const pageQuads = readUint32Words(bytes, offset, pageMetadata.quadWordLength);
      offset += pageMetadata.quadWordLength * 4;
      const texels = readUint32Words(bytes, offset, pageMetadata.texelWordLength);
      offset += pageMetadata.texelWordLength * 4;
      surfaces.push({ quads: pageQuads, texels, width: pageMetadata.width, height: pageMetadata.height });
    }
    validateSurfacePages(surfaces, bounds);
    worldQuads.transparentDepth = { quads, surfaces };
  }

  return {
    opaque: null,
    cutout: null,
    transparent: null,
    water: null,
    emissive: null,
    bounds: metadata.bounds,
    filteredBlockCount: metadata.filteredBlockCount,
    worldQuads,
  };
}
