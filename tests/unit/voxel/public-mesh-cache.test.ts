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

function testMeshCacheKeyIdentityTransition() {
  type BuildIdentity = {
    palette: "simple" | "advanced";
    blocksRef: object | null;
    meshCacheKey: string | null;
  };

  function sameIdentity(a: BuildIdentity | null, b: BuildIdentity | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
      a.palette === b.palette &&
      a.blocksRef === b.blocksRef &&
      a.meshCacheKey === b.meshCacheKey
    );
  }

  const blocksObj = {};
  const streamingIdentity: BuildIdentity = {
    palette: "simple",
    blocksRef: blocksObj,
    meshCacheKey: null,
  };
  const authoritativeIdentity: BuildIdentity = {
    palette: "simple",
    blocksRef: blocksObj,
    meshCacheKey: "public:abc123def456:full:simple:42000",
  };

  // When authoritative meshCacheKey appears, identity must change to trigger caching
  assert.equal(sameIdentity(streamingIdentity, streamingIdentity), true);
  assert.equal(sameIdentity(streamingIdentity, authoritativeIdentity), false);
  assert.equal(sameIdentity(authoritativeIdentity, authoritativeIdentity), true);
}

function main() {
  testPublicMeshCacheKey();
  testMeshCacheKeyIdentityTransition();
  console.log("public mesh cache key unit tests passed");
}

main();
