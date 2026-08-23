import assert from "node:assert/strict";
import * as THREE from "three";
import { configureAtlasTexture } from "../../../lib/voxel/mesh";
import {
  CACHE_VERSION,
  buildPersistentMeshCacheKey,
} from "../../../lib/voxel/meshPayloadCache";

async function main() {
  {
    assert.equal(CACHE_VERSION, "v3");
    assert.equal(buildPersistentMeshCacheKey("test-hash-123"), "v3:test-hash-123");
    assert.notEqual(buildPersistentMeshCacheKey("test-hash-123"), "v2:test-hash-123");
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
      [1023, 1023, 1023, 5],
      [0, 0, 1023, 6],
    ];

    for (const [x, y, z, typeId] of testCoords) {
      table.set(x, y, z, typeId);
    }

    for (const [x, y, z, typeId] of testCoords) {
      assert.equal(table.get(x, y, z), typeId, `lookup failed for (${x}, ${y}, ${z})`);
    }

    assert.equal(table.get(1023, 1023, 1022), -1);
    assert.equal(table.get(0, 0, 513), -1);
    assert.equal(table.get(-1, 0, 0), -1);
    assert.equal(table.get(1024, 0, 0), -1);
  }

  console.log("mesh atlas cache and texture configuration checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
