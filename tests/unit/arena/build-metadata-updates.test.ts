import assert from "node:assert/strict";
import {
  getCachedPreparedArenaBuild,
  getPreparedArenaBuildCoreMetadataUpdate,
  prepareArenaBuild,
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
    "metadata updates must write core metadata only",
  );
  assert.equal(core.voxelSha256, prepared.checksum);
  for (const key of SNAPSHOT_KEYS) {
    assert.ok(!(key in core), `metadata update must not carry ${key}`);
  }

  const privateSource: ArenaBuildSource = {
    ...makeSource(),
    id: "private-build",
    privateAccessOnly: true,
    voxelData: {
      version: "1.0",
      blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
    },
  };
  await prepareArenaBuild(privateSource);
  assert.equal(
    getCachedPreparedArenaBuild(privateSource.id, privateSource.voxelSha256),
    null,
    "private payloads must not remain in the shared prepared-build cache",
  );

  console.log("build metadata update checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
