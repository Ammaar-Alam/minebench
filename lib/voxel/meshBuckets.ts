// Mesh attributes, not block data, dominate what a large build costs the
// client: every visible face becomes four vertices plus six indices, so a build
// with a few hundred thousand visible blocks produces geometry an order of
// magnitude larger than the blocks it came from.
//
// Buckets therefore accumulate into typed arrays rather than JS number arrays,
// which hold doubles and so pay twice over for values that are floats at most,
// and each attribute is stored at the narrowest width that represents it
// exactly: face normals are axis-aligned, atlas coordinates sit in [0,1], and
// tints are flat. Positions stay at full float width because the viewer's
// bounds and framing are computed against them.

export type MeshBucket = {
  positions: Float32Array;
  // -127/0/127 read back as -1/0/1 through a signed-normalized attribute
  normals: Int8Array;
  uvs: Uint16Array | Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
};

export type SerializedMeshBucket = {
  positions: Float32Array;
  normals: Int8Array;
  uvs: Uint16Array | Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
};

const INITIAL_QUADS = 512;
const NORMAL_UNIT = 127;
const UV_UNIT = 65535;
const COLOR_UNIT = 255;

export function makeBucket(
  options: { repeatingUvs?: boolean } = {},
): MeshBucket {
  return {
    positions: new Float32Array(INITIAL_QUADS * 4 * 3),
    normals: new Int8Array(INITIAL_QUADS * 4 * 3),
    uvs: options.repeatingUvs
      ? new Float32Array(INITIAL_QUADS * 4 * 2)
      : new Uint16Array(INITIAL_QUADS * 4 * 2),
    colors: new Uint8Array(INITIAL_QUADS * 4 * 3),
    indices: new Uint32Array(INITIAL_QUADS * 6),
    vertexCount: 0,
    indexCount: 0,
  };
}

function grow<T extends Float32Array | Int8Array | Uint16Array | Uint8Array | Uint32Array>(
  current: T,
  needed: number,
  used: number,
): T {
  if (needed <= current.length) return current;
  let next = Math.max(current.length, 1);
  while (next < needed) next *= 2;
  const grown = new (current.constructor as new (length: number) => T)(next);
  grown.set(current.subarray(0, used) as never);
  return grown;
}

function ensureCapacity(bucket: MeshBucket, extraVertices: number, extraIndices: number): void {
  const vertices = bucket.vertexCount + extraVertices;
  const indices = bucket.indexCount + extraIndices;
  bucket.positions = grow(bucket.positions, vertices * 3, bucket.vertexCount * 3);
  bucket.normals = grow(bucket.normals, vertices * 3, bucket.vertexCount * 3);
  bucket.uvs = grow(bucket.uvs, vertices * 2, bucket.vertexCount * 2);
  bucket.colors = grow(bucket.colors, vertices * 3, bucket.vertexCount * 3);
  bucket.indices = grow(bucket.indices, indices, bucket.indexCount);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function appendQuad(
  bucket: MeshBucket,
  verts: readonly (readonly [number, number, number])[],
  normal: { nx: number; ny: number; nz: number },
  tint: readonly [number, number, number],
  uv: readonly [number, number, number, number, number, number, number, number],
): void {
  ensureCapacity(bucket, 4, 6);

  const baseIndex = bucket.vertexCount;
  const nx = normal.nx * NORMAL_UNIT;
  const ny = normal.ny * NORMAL_UNIT;
  const nz = normal.nz * NORMAL_UNIT;
  const r = Math.round(clamp01(tint[0]) * COLOR_UNIT);
  const g = Math.round(clamp01(tint[1]) * COLOR_UNIT);
  const b = Math.round(clamp01(tint[2]) * COLOR_UNIT);

  for (let i = 0; i < 4; i += 1) {
    const vert = verts[i];
    const p = (baseIndex + i) * 3;
    bucket.positions[p] = vert[0];
    bucket.positions[p + 1] = vert[1];
    bucket.positions[p + 2] = vert[2];
    bucket.normals[p] = nx;
    bucket.normals[p + 1] = ny;
    bucket.normals[p + 2] = nz;
    bucket.colors[p] = r;
    bucket.colors[p + 1] = g;
    bucket.colors[p + 2] = b;
    const u = (baseIndex + i) * 2;
    if (bucket.uvs instanceof Float32Array) {
      bucket.uvs[u] = uv[i * 2];
      bucket.uvs[u + 1] = uv[i * 2 + 1];
    } else {
      bucket.uvs[u] = Math.round(clamp01(uv[i * 2]) * UV_UNIT);
      bucket.uvs[u + 1] = Math.round(clamp01(uv[i * 2 + 1]) * UV_UNIT);
    }
  }

  const idx = bucket.indexCount;
  bucket.indices[idx] = baseIndex;
  bucket.indices[idx + 1] = baseIndex + 1;
  bucket.indices[idx + 2] = baseIndex + 2;
  bucket.indices[idx + 3] = baseIndex;
  bucket.indices[idx + 4] = baseIndex + 2;
  bucket.indices[idx + 5] = baseIndex + 3;

  bucket.vertexCount += 4;
  bucket.indexCount += 6;
}

// Trimmed to the filled prefix so the arrays that cross to the main thread and
// on to the GPU carry no slack from the growth steps.
//
// Each source array is released as soon as it has been copied. Trimming holds
// two copies of whatever it is working on, and on a large build that is tens of
// megabytes, so the bucket must not keep the originals alive until the end.
function trim<T extends Float32Array | Int8Array | Uint16Array | Uint8Array | Uint32Array>(
  source: T,
  used: number,
): T {
  return (source.length === used ? source : source.slice(0, used)) as T;
}

const EMPTY = {
  positions: new Float32Array(0),
  normals: new Int8Array(0),
  uvs: new Uint16Array(0),
  repeatingUvs: new Float32Array(0),
  colors: new Uint8Array(0),
  indices: new Uint32Array(0),
};

export function serializeBucket(bucket: MeshBucket): SerializedMeshBucket | null {
  if (bucket.indexCount === 0) return null;
  const vertices = bucket.vertexCount;

  const positions = trim(bucket.positions, vertices * 3);
  bucket.positions = EMPTY.positions;
  const normals = trim(bucket.normals, vertices * 3);
  bucket.normals = EMPTY.normals;
  const repeatingUvs = bucket.uvs instanceof Float32Array;
  const uvs = trim(bucket.uvs, vertices * 2);
  bucket.uvs = repeatingUvs ? EMPTY.repeatingUvs : EMPTY.uvs;
  const colors = trim(bucket.colors, vertices * 3);
  bucket.colors = EMPTY.colors;
  const indices = trim(bucket.indices, bucket.indexCount);
  bucket.indices = EMPTY.indices;

  // the bucket is consumed: its arrays now belong to the serialized result
  bucket.vertexCount = 0;
  bucket.indexCount = 0;

  return { positions, normals, uvs, colors, indices };
}

export function bucketTransferables(bucket: SerializedMeshBucket | null): ArrayBuffer[] {
  if (!bucket) return [];
  return [
    bucket.positions.buffer,
    bucket.normals.buffer,
    bucket.uvs.buffer,
    bucket.colors.buffer,
    bucket.indices.buffer,
  ] as ArrayBuffer[];
}
