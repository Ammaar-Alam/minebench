import type { VoxelExportGeometry } from "@/lib/voxel/export/geometry";

const STL_HEADER_BYTES = 80;
const STL_TRIANGLE_BYTES = 50;

function writeAsciiHeader(bytes: Uint8Array, text: string) {
  const encoded = new TextEncoder().encode(text.slice(0, STL_HEADER_BYTES));
  bytes.set(encoded, 0);
}

export function buildVoxelStl(geometry: VoxelExportGeometry): Uint8Array {
  if (geometry.triangleCount <= 0 || geometry.buckets.length === 0) {
    throw new Error("No visible faces to export");
  }
  if (geometry.triangleCount > 0xffffffff) {
    throw new Error("Too many triangles for binary STL");
  }

  const out = new Uint8Array(STL_HEADER_BYTES + 4 + geometry.triangleCount * STL_TRIANGLE_BYTES);
  const view = new DataView(out.buffer);
  writeAsciiHeader(out, "MineBench binary STL export");
  view.setUint32(STL_HEADER_BYTES, geometry.triangleCount, true);

  let offset = STL_HEADER_BYTES + 4;
  for (const bucket of geometry.buckets) {
    for (let i = 0; i < bucket.indices.length; i += 3) {
      const ia = bucket.indices[i] ?? 0;
      const ib = bucket.indices[i + 1] ?? 0;
      const ic = bucket.indices[i + 2] ?? 0;
      const nx = bucket.normals[ia * 3] ?? 0;
      const ny = bucket.normals[ia * 3 + 1] ?? 0;
      const nz = bucket.normals[ia * 3 + 2] ?? 0;
      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);
      offset += 12;

      for (const vertexIndex of [ia, ib, ic]) {
        view.setFloat32(offset, bucket.positions[vertexIndex * 3] ?? 0, true);
        view.setFloat32(offset + 4, bucket.positions[vertexIndex * 3 + 1] ?? 0, true);
        view.setFloat32(offset + 8, bucket.positions[vertexIndex * 3 + 2] ?? 0, true);
        offset += 12;
      }

      view.setUint16(offset, 0, true);
      offset += 2;
    }
  }

  return out;
}
