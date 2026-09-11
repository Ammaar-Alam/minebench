import assert from "node:assert/strict";
import { computeFaceAO, computeVisibleFaceMask, DIRS, SpatialBlockTable } from "@/lib/voxel/ambientOcclusion";
import { createWorldRegionBlockTable } from "@/lib/voxel/worldRegionMesh";

const size = { x: 384, y: 256, z: 512 };
const cells = (size.x + 2) * (size.y + 2) * (size.z + 2);
const capacity = Math.ceil(cells / 12);
const occluding = new Uint8Array(300);
occluding.set([1, 1, 1]);
const types = new Uint16Array([0, 1, 2, 3, 4, 5, 65535]);
const table = createWorldRegionBlockTable(size, occluding, capacity, types, new Uint16Array([299]));
const reference = new SpatialBlockTable(512);
for (let x = 0; x < 7; x += 1) for (let y = 0; y < 7; y += 1) for (let z = 0; z < 7; z += 1) {
  const type = (x * 7 + y * 11 + z * 13) % 8;
  if (type === 7) continue;
  const typeId = type === 6 ? 299 : type;
  table.set(x, y, z, typeId);
  reference.set(x, y, z, typeId);
}
for (let x = 1; x < 6; x += 1) for (let y = 1; y < 6; y += 1) for (let z = 1; z < 6; z += 1) {
  for (const typeId of [0, 1, 2, 3, 4, 5, 299]) {
    assert.equal(computeVisibleFaceMask(x, y, z, typeId, table, occluding), computeVisibleFaceMask(x, y, z, typeId, reference, occluding), "opaque aliases must preserve distinct transparent boundaries");
  }
  for (const direction of DIRS) {
    assert.deepEqual(computeFaceAO(direction, x, y, z, table, occluding), computeFaceAO(direction, x, y, z, reference, occluding));
  }
}
table.set(100, 100, 0, 1);
table.set(100, 100, 1, 299);
assert.equal(table.get(100, 100, 0), 0, "opaque neighbors share the first opaque code");
assert.equal(table.get(100, 100, 1), 299, "halo-only transparent types retain their identity");
table.set(100, 100, 0, 4);
assert.equal(table.get(100, 100, 0), 4);
assert.equal(table.get(100, 100, 1), 299, "overwriting one nibble cannot alter its neighbor");
table.set(size.x + 1, size.y + 1, size.z + 1, 299);
assert.equal(table.get(size.x + 1, size.y + 1, size.z + 1), 299);
assert.equal(table.get(-1, 0, 0), -1);
assert.equal(table.get(size.x + 2, 0, 0), -1);
assert.equal(table.get(0, size.y + 2, 0), -1);
assert.equal(table.get(0, 0, size.z + 2), -1);

for (const [volume, count, names] of [
  [{ x: 4, y: 4, z: 4 }, 64, types],
  [size, 1, types],
  [size, capacity, Uint16Array.from({ length: 20 }, (_, i) => i)],
] as const) {
  const fallback = createWorldRegionBlockTable(volume, occluding, count, names);
  fallback.set(1, 1, 1, 1);
  assert.equal(fallback.get(1, 1, 1), 1, "dense and sparse fallbacks keep complete material IDs");
}
console.log("world region lookup checks passed");
