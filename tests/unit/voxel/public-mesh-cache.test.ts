import assert from "node:assert/strict";
import {
  createPublicMeshCacheKey,
  type PublicMeshCacheKeyParams,
} from "../../../lib/voxel/meshPayloadCache";

function testPublicMeshCacheKey() {
  const baseParams: PublicMeshCacheKeyParams = {
    checksum: "abc123def456",
    variant: "full",
    palette: "simple",
    blockCount: 42000,
  };

  // Deterministic key generation
  const key1 = createPublicMeshCacheKey(baseParams);
  const key2 = createPublicMeshCacheKey(baseParams);
  assert.equal(key1, "public:abc123def456:full:simple:42000");
  assert.equal(key1, key2);

  // Missing or whitespace checksum returns null
  assert.equal(createPublicMeshCacheKey({ ...baseParams, checksum: null }), null);
  assert.equal(createPublicMeshCacheKey({ ...baseParams, checksum: undefined }), null);
  assert.equal(createPublicMeshCacheKey({ ...baseParams, checksum: "   " }), null);

  // Different parameters produce distinct keys
  assert.notEqual(
    createPublicMeshCacheKey(baseParams),
    createPublicMeshCacheKey({ ...baseParams, variant: "preview" }),
  );
  assert.notEqual(
    createPublicMeshCacheKey(baseParams),
    createPublicMeshCacheKey({ ...baseParams, palette: "advanced" }),
  );
  assert.notEqual(
    createPublicMeshCacheKey(baseParams),
    createPublicMeshCacheKey({ ...baseParams, blockCount: 50000 }),
  );
  assert.notEqual(
    createPublicMeshCacheKey(baseParams),
    createPublicMeshCacheKey({ ...baseParams, checksum: "different_checksum" }),
  );
}

function main() {
  testPublicMeshCacheKey();
  console.log("public mesh cache key unit tests passed");
}

main();
