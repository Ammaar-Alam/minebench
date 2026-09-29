import assert from "node:assert/strict";
import * as THREE from "three";
import { getPalette } from "../../../lib/blocks/palettes";
import {
  configureAtlasTexture,
  createVoxelGroupAsync,
  type VoxelMeshStageEvent,
} from "../../../lib/voxel/mesh";
import {
  CACHE_VERSION,
  buildPersistentMeshCacheKey,
} from "../../../lib/voxel/meshPayloadCache";

async function main() {
  {
    assert.equal(CACHE_VERSION, "v5");
    assert.equal(buildPersistentMeshCacheKey("test-hash-123"), "v5:test-hash-123");
    assert.notEqual(buildPersistentMeshCacheKey("test-hash-123"), "v4:test-hash-123");
  }

  {
    const texture = new THREE.Texture();
    assert.equal(texture.version, 0);

    configureAtlasTexture(texture);
    assert.equal(texture.magFilter, THREE.NearestFilter);
    assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
    assert.equal(texture.generateMipmaps, true);
    assert.equal(texture.anisotropy, 4);
    assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping);
    assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
    assert.equal(texture.version, 1);

    // Subsequent calls on unchanged texture must be idempotent and avoid bumping version
    configureAtlasTexture(texture);
    assert.equal(texture.version, 1);
    configureAtlasTexture(texture);
    assert.equal(texture.version, 1);

    // If a property is modified, configureAtlasTexture updates it and bumps version
    texture.anisotropy = 1;
    configureAtlasTexture(texture);
    assert.equal(texture.anisotropy, 4);
    assert.equal(texture.version, 2);
  }

  {
    const { SpatialBlockTable } = await import("../../../lib/voxel/ambientOcclusion");
    const table = new SpatialBlockTable(100);

    const testCoords: Array<[number, number, number, number]> = [
      [0, 0, 0, 1],
      [100, 200, 300, 2],
      [512, 512, 512, 3],
      [100, 200, 750, 4],
      [1024, 0, 0, 5],
      [0, 1024, 0, 6],
      [8191, 8191, 8191, 7],
    ];

    for (const [x, y, z, typeId] of testCoords) {
      table.set(x, y, z, typeId);
    }

    for (const [x, y, z, typeId] of testCoords) {
      assert.equal(table.get(x, y, z), typeId, `lookup failed for (${x}, ${y}, ${z})`);
    }

    assert.equal(table.get(8191, 8191, 8190), -1);
    assert.equal(table.get(0, 0, 513), -1);
    assert.equal(table.get(-1, 0, 0), -1);
    assert.equal(table.get(8192, 0, 0), -1);
  }

  {
    const stages: VoxelMeshStageEvent[] = [];
    const group = await createVoxelGroupAsync(
      {
        version: "1.0",
        blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
      },
      getPalette("simple"),
      new THREE.Texture(),
      {
        yieldAfterMs: Number.POSITIVE_INFINITY,
        onStage(event) {
          stages.push(event);
        },
      },
    );
    assert.deepEqual(
      stages.map((event) => event.stage),
      ["mesh_started", "mesh_payload_complete", "three_group_complete"],
    );
    assert.ok(stages.every((event) => event.strategy === "local"));
    assert.equal(stages.at(-1)?.cacheStatus, "not-used");
    group.dispose();
  }

  {
    const group = await createVoxelGroupAsync(
      {
        version: "1.0",
        blocks: [
          { x: 0, y: 0, z: 0, type: "water" },
          { x: 0, y: 1024, z: 0, type: "water" },
        ],
      },
      getPalette("simple"),
      new THREE.Texture(),
      { yieldAfterMs: Number.POSITIVE_INFINITY },
    );
    const waterMesh = group.group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.renderOrder === 1,
    );
    assert.ok(waterMesh, "high-coordinate water should create a water mesh");
    assert.equal(waterMesh.geometry.getIndex()?.count, 72);
    assert.equal(group.stats.blockCount, 2);
    group.dispose();
  }

  console.log("mesh atlas cache and texture configuration checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
