import assert from "node:assert/strict";
import {
  getPreparedArenaBuildCoreMetadataUpdate,
  getPreparedArenaBuildMetadataUpdate,
  prepareArenaBuildFromBuild,
  type ArenaBuildSource,
} from "../../../lib/arena/buildArtifacts";

const SNAPSHOT_KEYS = [
  "arenaSnapshotPreview",
  "arenaSnapshotPreviewChecksum",
  "arenaSnapshotFull",
  "arenaSnapshotFullChecksum",
];

function makeSource(): ArenaBuildSource {
  return {
    id: "test-build",
    gridSize: 64,
    palette: "simple",
    blockCount: 2,
    voxelByteSize: null,
    voxelCompressedByteSize: null,
    voxelSha256: "abc123",
    voxelData: null,
    voxelStorageBucket: null,
    voxelStoragePath: null,
    voxelStorageEncoding: null,
  };
}

async function main() {
  const prepared = prepareArenaBuildFromBuild(makeSource(), {
    version: "1.0",
    blocks: [
      { x: 0, y: 0, z: 0, type: "stone" },
      { x: 1, y: 0, z: 0, type: "stone" },
    ],
  });

  const core = getPreparedArenaBuildCoreMetadataUpdate(prepared);
  assert.deepEqual(
    Object.keys(core).sort(),
    ["arenaBuildHints", "voxelSha256"],
    "hot-route heals must write core metadata only",
  );
  assert.equal(core.voxelSha256, prepared.checksum);
  for (const key of SNAPSHOT_KEYS) {
    assert.ok(!(key in core), `core metadata update must not carry ${key}`);
  }

  const full = getPreparedArenaBuildMetadataUpdate(prepared);
  for (const key of ["voxelSha256", "arenaBuildHints", ...SNAPSHOT_KEYS]) {
    assert.ok(key in full, `maintenance metadata update must carry ${key}`);
  }
  assert.equal(full.voxelSha256, core.voxelSha256);
  assert.deepEqual(full.arenaBuildHints, core.arenaBuildHints);

  console.log("build metadata update split checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
