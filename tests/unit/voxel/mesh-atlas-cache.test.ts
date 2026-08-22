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

  console.log("mesh atlas cache and texture configuration checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
