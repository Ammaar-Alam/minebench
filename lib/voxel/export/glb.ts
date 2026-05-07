import type { VoxelExportGeometry } from "@/lib/voxel/export/geometry";

type GltfBufferView = {
  buffer: 0;
  byteOffset: number;
  byteLength: number;
  target?: 34962 | 34963;
};

type GltfAccessor = {
  bufferView: number;
  componentType: 5126 | 5125;
  count: number;
  type: "SCALAR" | "VEC3";
  min?: number[];
  max?: number[];
};

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;

function typedArrayBytes(array: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function padTo4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function computeVec3MinMax(values: number[]): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < values.length; i += 3) {
    const x = values[i] ?? 0;
    const y = values[i + 1] ?? 0;
    const z = values[i + 2] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function buildVoxelGlb(geometry: VoxelExportGeometry): Uint8Array {
  if (geometry.triangleCount <= 0 || geometry.buckets.length === 0) {
    throw new Error("No visible faces to export");
  }

  const bufferViews: GltfBufferView[] = [];
  const accessors: GltfAccessor[] = [];
  const binParts: Uint8Array[] = [];
  let binByteLength = 0;

  const appendBuffer = (bytes: Uint8Array, target: 34962 | 34963): number => {
    const padding = padTo4(binByteLength);
    if (padding > 0) {
      binParts.push(new Uint8Array(padding));
      binByteLength += padding;
    }
    const byteOffset = binByteLength;
    binParts.push(bytes);
    binByteLength += bytes.byteLength;
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, target });
    return viewIndex;
  };

  const materials = geometry.buckets.map((bucket) => {
    const material = bucket.material;
    return {
      name: material.materialName,
      pbrMetallicRoughness: {
        baseColorFactor: material.baseColorFactor,
        metallicFactor: material.blockId === "iron_block" || material.blockId === "gold_block" ? 0.25 : 0,
        roughnessFactor: 0.86,
      },
      emissiveFactor: material.emissiveFactor,
      alphaMode: material.alphaMode,
      alphaCutoff: material.alphaMode === "MASK" ? 0.45 : undefined,
      doubleSided: material.doubleSided,
      extras: {
        minebenchBlockId: material.blockId,
        minecraftBlockState: material.minecraftBlockState,
      },
    };
  });

  const primitives = geometry.buckets.map((bucket, materialIndex) => {
    const positions = Float32Array.from(bucket.positions);
    const normals = Float32Array.from(bucket.normals);
    const indices = Uint32Array.from(bucket.indices);
    const positionMinMax = computeVec3MinMax(bucket.positions);

    const positionView = appendBuffer(typedArrayBytes(positions), 34962);
    const normalView = appendBuffer(typedArrayBytes(normals), 34962);
    const indexView = appendBuffer(typedArrayBytes(indices), 34963);

    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: positions.length / 3,
      type: "VEC3",
      min: positionMinMax.min,
      max: positionMinMax.max,
    });

    const normalAccessor = accessors.length;
    accessors.push({
      bufferView: normalView,
      componentType: 5126,
      count: normals.length / 3,
      type: "VEC3",
    });

    const indexAccessor = accessors.length;
    accessors.push({
      bufferView: indexView,
      componentType: 5125,
      count: indices.length,
      type: "SCALAR",
    });

    return {
      attributes: {
        POSITION: positionAccessor,
        NORMAL: normalAccessor,
      },
      indices: indexAccessor,
      material: materialIndex,
      mode: 4,
    };
  });

  const binPadding = padTo4(binByteLength);
  if (binPadding > 0) {
    binParts.push(new Uint8Array(binPadding));
    binByteLength += binPadding;
  }

  const json = {
    asset: {
      version: "2.0",
      generator: "MineBench voxel exporter",
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "MineBench Build" }],
    meshes: [{ name: "MineBench Build", primitives }],
    materials,
    buffers: [{ byteLength: binByteLength }],
    bufferViews,
    accessors,
    extras: {
      minebench: {
        inputBlockCount: geometry.inputBlockCount,
        exportedBlockCount: geometry.exportedBlockCount,
        visibleFaceCount: geometry.visibleFaceCount,
        triangleCount: geometry.triangleCount,
        bounds: geometry.bounds,
      },
    },
  };

  const jsonBytesRaw = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadding = padTo4(jsonBytesRaw.byteLength);
  const jsonByteLength = jsonBytesRaw.byteLength + jsonPadding;
  const totalLength = 12 + 8 + jsonByteLength + 8 + binByteLength;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);

  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonByteLength, true);
  view.setUint32(16, JSON_CHUNK_TYPE, true);
  out.set(jsonBytesRaw, 20);
  out.fill(0x20, 20 + jsonBytesRaw.byteLength, 20 + jsonByteLength);

  const binHeaderOffset = 20 + jsonByteLength;
  view.setUint32(binHeaderOffset, binByteLength, true);
  view.setUint32(binHeaderOffset + 4, BIN_CHUNK_TYPE, true);
  let binOffset = binHeaderOffset + 8;
  for (const part of binParts) {
    out.set(part, binOffset);
    binOffset += part.byteLength;
  }

  return out;
}
