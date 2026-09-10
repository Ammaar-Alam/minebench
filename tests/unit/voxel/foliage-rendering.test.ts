import assert from "node:assert/strict";
import * as THREE from "three";
import { getPalette } from "../../../lib/blocks/palettes";
import { createVoxelGroup, createVoxelGroupFromMeshPayload, type VoxelGroup } from "../../../lib/voxel/mesh";
import { buildMeshPayload } from "../../../lib/voxel/mesh.worker";
import { packVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { buildWorldRegionGreedyMeshPayload } from "../../../lib/voxel/worldRegionMesh";
import { WORLD_QUAD_TINT_LEAVES, WORLD_QUAD_TINT_WHITE, WORLD_QUAD_TINTS } from "../../../lib/voxel/worldQuadData";
import { createVoxelWorldScene } from "../../../lib/voxel/worldScene";

const palette = getPalette("advanced");
const tintedLeaves = new Set([
  "oak_leaves", "spruce_leaves", "birch_leaves", "jungle_leaves",
  "acacia_leaves", "dark_oak_leaves", "mangrove_leaves",
]);

function leafMesh(model: VoxelGroup): THREE.Mesh {
  assert.equal(model.stats.blockCount, 1);
  const meshes: THREE.Mesh[] = [];
  model.group.traverse((child) => { if (child instanceof THREE.Mesh) meshes.push(child); });
  assert.equal(meshes.length, 1, "each leaf cell retains its cutout geometry");
  const material = meshes[0].material as THREE.MeshLambertMaterial;
  assert.equal(material.alphaTest, 0.45);
  assert.equal(material.transparent, false);
  assert.equal(material.opacity, 1);
  assert.equal(material.depthWrite, true);
  assert.equal(material.side, THREE.FrontSide);
  return meshes[0];
}

async function main() {
  for (const { id } of palette.filter((block) => block.id.endsWith("_leaves")).sort((a, b) => a.id.localeCompare(b.id))) {
    const tintIndex = tintedLeaves.has(id) ? WORLD_QUAD_TINT_LEAVES : WORLD_QUAD_TINT_WHITE;
    const expectedColor = WORLD_QUAD_TINTS[tintIndex].map((channel) => Math.round(channel * 255));
    const build = { version: "1.0" as const, blocks: [{ x: 0, y: 0, z: 0, type: id }] };
    const packed = packVoxelBlocks(build.blocks);
    const worker = buildMeshPayload(packed, palette.map((block) => block.id));
    assert.equal(worker.filteredBlockCount, 1);
    assert.equal(worker.cutout?.indices.length, 36);
    assert.deepEqual(Array.from(worker.cutout!.colors.subarray(0, 3)), expectedColor, `${id} worker tint`);

    const compact = buildWorldRegionGreedyMeshPayload(packed, palette.map((block) => block.id), { size: { x: 1, y: 1, z: 1 } });
    const words = compact.worldQuads!.cutout!;
    assert.equal(words.length, 6 * 4, `${id} retains all six unit faces`);
    for (let offset = 0; offset < words.length; offset += 4) {
      assert.equal(words[offset + 3] & 3, tintIndex, `${id} compact tint`);
      assert.equal(words[offset + 1] & 1023, 1);
      assert.equal((words[offset + 1] >>> 10) & 1023, 1);
    }

    const local = createVoxelGroup(build, palette, new THREE.Texture());
    const uniform = await createVoxelWorldScene({ manifest: {
      kind: "voxel_world", version: 1, gridSize: 8192, palette: "advanced", leafSize: 64,
      source: { format: "build_json", sha256: "a".repeat(64), evaluatorVersion: 1 },
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      exactBlockCount: 1,
      regions: [{ kind: "uniform", key: id, origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, type: id, blockCount: 1 }],
    }, resolvePart: async () => { throw new Error("uniform foliage requires no source read"); } }, palette, new THREE.Texture());
    const savedWords = words.slice();
    for (let offset = 0; offset < savedWords.length; offset += 4) savedWords[offset + 3] &= ~3;
    const savedGeometry = savedWords.slice();
    compact.worldQuads!.cutout = savedWords;
    const mixed = createVoxelGroupFromMeshPayload(compact, new THREE.Texture());
    try {
      for (const [name, model] of [["local", local], ["uniform", uniform]] as const) {
        const geometry = leafMesh(model).geometry;
        assert.equal(geometry.index?.count, 36);
        assert.deepEqual(Array.from(geometry.getAttribute("color").array.slice(0, 3)), expectedColor, `${id} ${name} tint`);
      }
      const mesh = leafMesh(mixed);
      assert.equal((mesh.customDepthMaterial as THREE.MeshDepthMaterial).alphaTest, 0.45, `${id} depth pass retains cutout alpha`);
      for (let offset = 0; offset < savedWords.length; offset += 1) {
        assert.equal(savedWords[offset], offset % 4 === 3 ? savedGeometry[offset] | tintIndex : savedGeometry[offset],
          `${id} saved mesh changes only its tint bits`);
      }
      const textureData = (mesh.geometry.userData.worldQuadTexture as THREE.DataTexture).image.data;
      assert.ok(textureData instanceof Uint32Array);
      assert.deepEqual(Array.from(textureData.slice(0, savedWords.length)),
        Array.from(savedWords), `${id} uploads the corrected saved tint`);
    } finally {
      local.dispose();
      uniform.dispose();
      mixed.dispose();
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
