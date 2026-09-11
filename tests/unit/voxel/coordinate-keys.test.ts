import assert from "node:assert/strict";
import {
  decodeVoxelPositionKey,
  encodeVoxelPositionKey,
  hashVoxelPositionKey,
  isVoxelCoordinateInRange,
  packVoxelPlaneCell,
  unpackVoxelPlaneCellU,
  unpackVoxelPlaneCellV,
} from "../../../lib/voxel/coordinateKeys";

const POSITION_SAMPLES: Array<readonly [number, number, number]> = [
  [0, 0, 0],
  [1024, 0, 0],
  [0, 1024, 0],
  [0, 0, 1024],
  [8191, 8191, 8191],
];

for (const position of POSITION_SAMPLES) {
  const key = encodeVoxelPositionKey(...position);
  assert.equal(Number.isSafeInteger(key), true);
  assert.deepEqual(decodeVoxelPositionKey(key), position);
}

const edgeAndNeighborKeys = new Set(
  [
    [0, 0, 0],
    [-1, 0, 0],
    [8191, 0, 0],
    [8192, 0, 0],
    [0, -1, 0],
    [0, 8192, 0],
    [0, 0, -1],
    [0, 0, 8192],
  ].map(([x, y, z]) => encodeVoxelPositionKey(x, y, z)),
);
assert.equal(edgeAndNeighborKeys.size, 8);

assert.equal(isVoxelCoordinateInRange(0), true);
assert.equal(isVoxelCoordinateInRange(8191), true);
assert.equal(isVoxelCoordinateInRange(-1), false);
assert.equal(isVoxelCoordinateInRange(8192), false);
assert.equal(isVoxelCoordinateInRange(1.5), false);

const planeCells = [
  [0, 0],
  [1024, 0],
  [0, 1024],
  [8191, 8191],
] as const;
const packedPlaneCells = new Set(planeCells.map(([u, v]) => packVoxelPlaneCell(u, v)));
assert.equal(packedPlaneCells.size, planeCells.length);
for (const [u, v] of planeCells) {
  const cell = packVoxelPlaneCell(u, v);
  assert.equal(unpackVoxelPlaneCellU(cell), u);
  assert.equal(unpackVoxelPlaneCellV(cell), v);
}

assert.notEqual(hashVoxelPositionKey(0, 0, 0), hashVoxelPositionKey(1024, 0, 0));

console.log("voxel coordinate key checks passed");
