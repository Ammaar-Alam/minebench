import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildMeshPayload } from "../../../lib/voxel/mesh.worker";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { getPalette } from "../../../lib/blocks/palettes";
import type { SerializedMeshBucket } from "../../../lib/voxel/mesh";

function testWorkerMeshingVariousMaterials() {
  const palette = getPalette("simple");
  const allowed = palette.map((p) => p.id);

  const build = packVoxelBlocks([
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 0, y: 1, z: 0, type: "grass_block" },
    { x: 0, y: 2, z: 0, type: "oak_leaves" },
    { x: 1, y: 0, z: 0, type: "water" },
    { x: 1, y: 1, z: 0, type: "water" },
    { x: 2, y: 0, z: 0, type: "glass" },
    { x: 2, y: 1, z: 0, type: "glowstone" },
  ]);

  const payload = buildMeshPayload(build, allowed);

  assert.equal(payload.filteredBlockCount, 7);
  assert.ok(payload.opaque != null, "should have opaque geometry");
  assert.ok(payload.water != null, "should have water geometry");
  assert.ok(payload.transparent != null, "should have transparent geometry for glass");
  assert.ok(payload.emissive != null, "should have emissive geometry for glowstone");

  // Verify bounds
  assert.ok(Number.isFinite(payload.bounds.radius));
  assert.ok(payload.bounds.radius > 0);
  assert.equal(payload.bounds.min.length, 3);
  assert.equal(payload.bounds.max.length, 3);
}

function testWorkerMeshingOcclusionCulling() {
  const palette = getPalette("simple");
  const allowed = palette.map((p) => p.id);

  // A 3x3x3 solid cube of stone: 27 blocks total
  // Center block (1,1,1) is completely occluded and must be filtered out
  const blocks: Array<{ x: number; y: number; z: number; type: string }> = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        blocks.push({ x, y, z, type: "stone" });
      }
    }
  }

  const build = packVoxelBlocks(blocks);
  const payload = buildMeshPayload(build, allowed);

  // 26 outer blocks remain visible, 1 center block culled
  assert.equal(payload.filteredBlockCount, 26);
  assert.ok(payload.opaque != null);
}

function testWorkerMeshingEmptyBuild() {
  const palette = getPalette("simple");
  const allowed = palette.map((p) => p.id);

  const build = packVoxelBlocks([]);
  const payload = buildMeshPayload(build, allowed);

  assert.equal(payload.filteredBlockCount, 0);
  assert.equal(payload.opaque, null);
  assert.equal(payload.water, null);
  assert.equal(payload.cutout, null);
  assert.equal(payload.transparent, null);
  assert.equal(payload.emissive, null);
}

function digestBucket(bucket: SerializedMeshBucket | null): string | null {
  if (!bucket) return null;
  const hash = createHash("sha256");
  for (const [name, array] of Object.entries(bucket)) {
    hash.update(name);
    hash.update(array.constructor.name);
    hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  return hash.digest("hex");
}

function testGoldenFixtureParity() {
  const allowed = ["stone", "grass_block", "oak_leaves", "glass", "water", "glowstone"];
  const packed = packVoxelBlocks([
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "stone" },
    { x: 0, y: 1, z: 0, type: "stone" },
    { x: 1, y: 1, z: 1, type: "grass_block" },
    { x: 2, y: 0, z: 0, type: "oak_leaves" },
    { x: 3, y: 0, z: 0, type: "glass" },
    { x: 4, y: 0, z: 0, type: "water" },
    { x: 4, y: 1, z: 0, type: "water" },
    { x: 5, y: 0, z: 0, type: "glowstone" },
  ]);
  const payload = buildMeshPayload(packed, allowed);

  // frozen from the preoptimization mesher so byte changes require deliberate review
  assert.deepEqual(
    {
      filteredBlockCount: payload.filteredBlockCount,
      bounds: payload.bounds,
      opaque: digestBucket(payload.opaque),
      cutout: digestBucket(payload.cutout),
      transparent: digestBucket(payload.transparent),
      water: digestBucket(payload.water),
      emissive: digestBucket(payload.emissive),
    },
    {
      filteredBlockCount: 9,
      bounds: {
        min: [-3, 0, -1],
        max: [3, 2, 1],
        center: [0, 1, 0],
        radius: 3.3166247903554,
      },
      opaque: "a161a573a19eefa0150c3dde2c637617bbf49ff489824f6d147cb423025e06e7",
      cutout: "c49e65f30520d9d6bb7f783b7e92b420d245882398fd3ddb9505007719456260",
      transparent: "4fb0e12448099b81991af525fe97f5de562270c946f7cba51344f180db0d6586",
      water: "3837124069a5028ab0ced933f1191134f2d3de55cb9673a833940f06ce5323b2",
      emissive: "f7111044e1120477b3eb69f210f93d251c42f4ba6323bbd0ba9703574adb29c5",
    },
  );

  assert.ok(buildMeshPayload(packed, allowed, 4).filteredBlockCount <= 4);
}

function main() {
  testWorkerMeshingVariousMaterials();
  testWorkerMeshingOcclusionCulling();
  testWorkerMeshingEmptyBuild();
  testGoldenFixtureParity();
  console.log("worker hot loop optimization unit tests passed");
}

main();
