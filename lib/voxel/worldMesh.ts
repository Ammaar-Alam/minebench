import { ATLAS } from "@/lib/blocks/atlas";
import type { SerializedBuildBounds, VoxelMeshPayload } from "@/lib/voxel/mesh";
import {
  WORLD_QUAD_WORDS,
  type WorldQuadBucketName,
  type WorldQuadPayload,
} from "@/lib/voxel/worldQuadData";

const MAGIC = 0x4d425131; // MBQ1
const RENDERER_VERSION = "v1";
const HEADER_BYTES = 8;
const MAX_METADATA_BYTES = 16 * 1024;
const BUCKET_NAMES = ["opaque", "cutout", "transparent", "water", "emissive"] as const;
const EPSILON = 1e-6;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

type Vec3 = [number, number, number];
type BucketWordLengths = Record<WorldQuadBucketName, number>;
type RawMeshBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};
type WorldMeshMetadata = {
  rendererVersion: typeof RENDERER_VERSION;
  anchor: Vec3;
  bounds: SerializedBuildBounds;
  filteredBlockCount: number;
  bucketWordLengths: BucketWordLengths;
};

let versionPromise: Promise<string> | null = null;
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

export function getWorldMeshVersion(): Promise<string> {
  versionPromise ??= (async () => {
    const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(JSON.stringify(ATLAS)));
    return `${RENDERER_VERSION}-${hex(new Uint8Array(digest))}`;
  })();
  return versionPromise;
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

function readMetadata(value: unknown): WorldMeshMetadata {
  assertWorldMesh(isRecord(value), "metadata must be an object");
  assertWorldMesh(value.rendererVersion === RENDERER_VERSION, "renderer version is unsupported");
  const filteredBlockCount = value.filteredBlockCount;
  assertNonNegativeSafeInt(filteredBlockCount, "filteredBlockCount");
  return {
    rendererVersion: RENDERER_VERSION,
    anchor: readFiniteVec3(value.anchor, "anchor"),
    bounds: readBounds(value.bounds),
    filteredBlockCount,
    bucketWordLengths: readBucketWordLengths(value.bucketWordLengths),
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

    const plane = word0 & 0x3ff;
    const u = (word0 >>> 10) & 0x3ff;
    const v = (word0 >>> 20) & 0x3ff;
    const width = word1 & 0x3ff;
    const height = (word1 >>> 10) & 0x3ff;
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

function assertCompactPayload(payload: VoxelMeshPayload): asserts payload is VoxelMeshPayload & { worldQuads: WorldQuadPayload } {
  assertWorldMesh(payload.opaque === null, "opaque legacy bucket must be null");
  assertWorldMesh(payload.cutout === null, "cutout legacy bucket must be null");
  assertWorldMesh(payload.transparent === null, "transparent legacy bucket must be null");
  assertWorldMesh(payload.water === null, "water legacy bucket must be null");
  assertWorldMesh(payload.emissive === null, "emissive legacy bucket must be null");
  assertWorldMesh(Boolean(payload.worldQuads), "worldQuads are required");
}

function metadataForPayload(payload: VoxelMeshPayload & { worldQuads: WorldQuadPayload }): WorldMeshMetadata {
  const metadata = readMetadata({
    rendererVersion: RENDERER_VERSION,
    anchor: payload.worldQuads.anchor,
    bounds: payload.bounds,
    filteredBlockCount: payload.filteredBlockCount,
    bucketWordLengths: Object.fromEntries(
      BUCKET_NAMES.map((name) => [name, payload.worldQuads[name]?.length ?? 0]),
    ),
  });
  const bounds = rawBounds(metadata);
  for (const name of BUCKET_NAMES) validateBucket(name, payload.worldQuads[name], bounds);
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

function totalBucketWords(lengths: BucketWordLengths): number {
  let total = 0;
  for (const name of BUCKET_NAMES) {
    const length = lengths[name];
    assertWorldMesh(total <= Number.MAX_SAFE_INTEGER - length, "bucket lengths overflow");
    total += length;
  }
  return total;
}

export function encodeWorldMeshPayload(payload: VoxelMeshPayload): Uint8Array {
  assertCompactPayload(payload);
  const metadata = metadataForPayload(payload);
  const metadataBytes = encodeMetadata(metadata);
  const bodyBytes = totalBucketWords(metadata.bucketWordLengths) * 4;
  const bytes = new Uint8Array(HEADER_BYTES + metadataBytes.byteLength + bodyBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, false);
  view.setUint32(4, metadataBytes.byteLength, false);
  bytes.set(metadataBytes, HEADER_BYTES);

  let offset = HEADER_BYTES + metadataBytes.byteLength;
  for (const name of BUCKET_NAMES) {
    const words = payload.worldQuads[name];
    if (!words) continue;
    bytes.set(new Uint8Array(words.buffer, words.byteOffset, words.byteLength), offset);
    offset += words.byteLength;
  }
  return bytes;
}

function readUint32Bucket(bytes: Uint8Array, offset: number, wordLength: number): Uint32Array | null {
  if (wordLength === 0) return null;
  const byteLength = wordLength * 4;
  if ((bytes.byteOffset + offset) % 4 === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset + offset, wordLength);
  }
  const copy = bytes.slice(offset, offset + byteLength);
  return new Uint32Array(copy.buffer, copy.byteOffset, wordLength);
}

export function decodeWorldMeshPayload(bytes: Uint8Array): VoxelMeshPayload {
  assertWorldMesh(bytes.byteLength >= HEADER_BYTES, "header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertWorldMesh(view.getUint32(0, false) === MAGIC, "magic is unsupported");
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
  const metadata = readMetadata(metadataJson);
  const bounds = rawBounds(metadata);
  const bodyOffset = HEADER_BYTES + metadataLength;
  const bodyBytes = totalBucketWords(metadata.bucketWordLengths) * 4;
  assertWorldMesh(bodyOffset + bodyBytes === bytes.byteLength, "bucket byte length mismatch");

  const worldQuads = { anchor: metadata.anchor } as WorldQuadPayload;
  let offset = bodyOffset;
  for (const name of BUCKET_NAMES) {
    const words = readUint32Bucket(bytes, offset, metadata.bucketWordLengths[name]);
    validateBucket(name, words, bounds);
    worldQuads[name] = words;
    offset += metadata.bucketWordLengths[name] * 4;
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
