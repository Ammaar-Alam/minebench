import assert from "node:assert/strict";
import { computeFaceAO, computePackedFaceAO, DIRS, SpatialBlockTable } from "../../../lib/voxel/ambientOcclusion";
import { MAX_VOXEL_COORDINATE } from "../../../lib/voxel/coordinateKeys";

const occluding = new Uint8Array([1, 0]);
let cases = 0;
for (const anchor of [0, 20, 1023, MAX_VOXEL_COORDINATE]) {
  for (const direction of DIRS) {
    const origin = [anchor + direction.dx, anchor + direction.dy, anchor + direction.dz];
    const offsets = [...new Map(direction.corners.flatMap((corner) => [corner.sideA, corner.sideB, corner.diag])
      .map((offset) => [offset.join(","), offset])).values()];
    assert.equal(offsets.length, 8);
    for (let mask = 0; mask < 256; mask += 1) {
      const table = new SpatialBlockTable(8);
      offsets.forEach((offset, index) => table.set(origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2],
        mask & (1 << index) ? 0 : 1));
      const isOccluding = (offset: readonly number[]) => {
        const type = table.get(origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2]);
        return type !== -1 && occluding[type] === 1;
      };
      const expected = direction.corners.map((corner) => {
        const a = isOccluding(corner.sideA), b = isOccluding(corner.sideB);
        if (a && b) return 0.58;
        return 0.58 + ((3 - Number(a) - Number(b) - Number(isOccluding(corner.diag))) / 3) * 0.42;
      });
      const calls = new Map<string, number>();
      const actual = computeFaceAO(direction, anchor, anchor, anchor, {
        get(x, y, z) {
          const key = `${x},${y},${z}`;
          calls.set(key, (calls.get(key) ?? 0) + 1);
          return table.get(x, y, z);
        },
      }, occluding);
      assert.deepEqual(actual, expected, `${anchor}/${direction.face}/${mask}`);
      const packed = computePackedFaceAO(direction, anchor, anchor, anchor, table, occluding);
      expected.forEach((factor, corner) => assert.equal((packed >>> (corner * 2)) & 3, Math.round((factor - .58) / .42 * 3)));
      assert.ok([...calls.values()].every((count) => count === 1), "each face neighbor is sampled at most once");
      cases += 1;
    }
  }
}
console.log(`ambient occlusion checks passed (${cases} exact corner cases)`);
