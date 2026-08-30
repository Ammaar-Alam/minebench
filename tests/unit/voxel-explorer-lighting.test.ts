import assert from "node:assert/strict";
import {
  clusterExplorerEmissiveFaces,
  selectNearestExplorerLightClusters,
} from "@/lib/voxel/explorerLighting";

const positions = new Float32Array([
  0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1,
  2, 0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1,
  16, 0, 0, 16, 1, 0, 16, 1, 1, 16, 0, 1,
]);

const clusters = clusterExplorerEmissiveFaces(positions, 8);
assert.equal(clusters.length, 2);
assert.deepEqual(clusters[0], { x: 1, y: 0.5, z: 0.5, faces: 2 });
assert.deepEqual(clusters[1], { x: 16, y: 0.5, z: 0.5, faces: 1 });

assert.deepEqual(
  selectNearestExplorerLightClusters(clusters, { x: 15, y: 0, z: 0 }, 1, 20),
  [clusters[1]],
);
assert.deepEqual(selectNearestExplorerLightClusters(clusters, { x: 40, y: 0, z: 0 }, 2, 8), []);
