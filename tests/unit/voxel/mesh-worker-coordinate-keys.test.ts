import assert from "node:assert/strict";
import {
  buildMeshPayload,
  buildMeshPayloadFromFacts,
} from "../../../lib/voxel/mesh.worker";
import { createVoxelMeshFacts } from "../../../lib/voxel/meshFacts";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";

{
  const allowed = ["water"];
  const build = packVoxelBlocks([
    { x: 0, y: 0, z: 0, type: "water" },
    { x: 0, y: 1024, z: 0, type: "water" },
  ]);

  const payload = buildMeshPayload(build, allowed);
  assert.deepEqual(buildMeshPayloadFromFacts(createVoxelMeshFacts(build), allowed), payload);
  assert.equal(payload.filteredBlockCount, 2);
  assert.equal(payload.water?.indices.length, 72);
}

{
  const allowed = ["stone", "water", "glass", "glowstone"];
  const build = packVoxelBlocks([
    { x: 8191, y: 1, z: 1, type: "stone" },
    { x: 8190, y: 1, z: 1, type: "stone" },
    { x: 8191, y: 2, z: 1, type: "glass" },
    { x: 1024, y: 1024, z: 1024, type: "glowstone" },
    { x: 0, y: 8191, z: 0, type: "water" },
  ]);

  const payload = buildMeshPayload(build, allowed);
  assert.deepEqual(buildMeshPayloadFromFacts(createVoxelMeshFacts(build), allowed), payload);
  assert.equal(payload.bounds.max[0] - payload.bounds.min[0], 8192);
  assert.equal(payload.bounds.max[1] - payload.bounds.min[1], 8191);
  assert.equal(payload.bounds.max[2] - payload.bounds.min[2], 1025);
  assert.ok(payload.opaque);
  assert.ok(payload.transparent);
  assert.ok(payload.water);
  assert.ok(payload.emissive);
}

console.log("worker coordinate key checks passed");
