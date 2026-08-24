import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

async function main() {
  process.env.ARENA_STREAM_ARTIFACTS_ENABLED = "false";
  process.env.SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  const { expectedArtifactRequirements } = await import(
    "../../../lib/arena/artifactCoverage"
  );
  const { arenaArtifactBuildWhere, arenaCohortBuildWhere } = await import(
    "../../../lib/arena/eligibility"
  );
  const {
    ARENA_BUILD_DERIVED_METADATA_RESET,
    getArenaBuildPayloadIdentity,
    getPreparedArenaBuildCoreMetadataUpdate,
    parsePersistedArenaBuildMetadata,
    prepareArenaBuildFromBuild,
  } = await import("../../../lib/arena/buildArtifacts");
  const checksum = "a".repeat(64);
  const publicScope = arenaCohortBuildWhere();
  const artifactScope = arenaArtifactBuildWhere();
  assert.equal(publicScope.model.stealthVariant, null);
  assert.equal(
    "stealthVariant" in artifactScope.model,
    false,
    "artifact maintenance must include enabled private checkpoints",
  );
  const expectations = expectedArtifactRequirements({
    id: "build-1",
    blockCount: 10_000,
    voxelByteSize: 500_000,
    voxelCompressedByteSize: 500,
    voxelSha256: checksum,
    arenaBuildHints: {
      initialVariant: "preview",
      initialDeliveryClass: "snapshot",
      deliveryClass: "stream-artifact",
      fullBlockCount: 600_000,
      previewBlockCount: 50_000,
      previewStride: 12,
      initialEstimatedBytes: 1_700_000,
      fullEstimatedBytes: 20_000_000,
    },
  });
  const streamRequirements = expectations.required.filter(
    (requirement) => requirement.kind === "stream",
  );

  assert.equal(
    streamRequirements.length,
    2,
    "persisted stream delivery must require both variants when raw size metadata is understated",
  );
  assert.equal(
    streamRequirements.every((requirement) => requirement.refs.length === 0),
    true,
    "disabled stream artifacts must remain missing under the deployed policy",
  );
  const previewRequirements = expectations.required.filter(
    (requirement) => requirement.kind === "snapshot" && requirement.variant === "preview",
  );
  assert.equal(
    previewRequirements.length,
    1,
    "stream builds with a smaller persisted preview must require its snapshot artifact",
  );
  assert.equal(previewRequirements[0]?.refs.length, 1);
  assert.ok(previewRequirements[0]?.refs[0]?.path.endsWith(`/preview-${checksum}.json`));
  const meshFactsRequirements = expectations.required.filter(
    (requirement) => requirement.kind === "snapshot-mesh-facts",
  );
  assert.equal(meshFactsRequirements.length, 1);
  assert.ok(meshFactsRequirements[0]?.refs[0]?.path.endsWith(`/full-${checksum}.mbf1`));

  const persistedSnapshotClass = expectedArtifactRequirements({
    id: "build-2",
    blockCount: 600_000,
    voxelByteSize: 20_000_000,
    voxelCompressedByteSize: 500,
    voxelSha256: checksum,
    arenaBuildHints: {
      initialVariant: "full",
      initialDeliveryClass: "snapshot",
      deliveryClass: "snapshot",
      fullBlockCount: 50_000,
      previewBlockCount: 50_000,
      previewStride: 1,
      initialEstimatedBytes: 3_000_000,
      fullEstimatedBytes: 3_000_000,
    },
  });
  const fullSnapshotRequirements = persistedSnapshotClass.required.filter(
    (requirement) => requirement.kind === "snapshot" && requirement.variant === "full",
  );
  assert.equal(
    fullSnapshotRequirements.length,
    1,
    "persisted snapshot delivery must require the artifact selected by the runtime",
  );
  assert.ok(fullSnapshotRequirements[0]?.refs[0]?.path.endsWith(`/full-${checksum}.json`));

  const malformedChecksum = expectedArtifactRequirements({
    id: "build-3",
    blockCount: 600_000,
    voxelByteSize: 20_000_000,
    voxelCompressedByteSize: 500,
    voxelSha256: "not-a-checksum",
    arenaBuildHints: {
      initialVariant: "preview",
      initialDeliveryClass: "snapshot",
      deliveryClass: "stream-artifact",
      fullBlockCount: 600_000,
      previewBlockCount: 50_000,
      previewStride: 12,
      initialEstimatedBytes: 1_700_000,
      fullEstimatedBytes: 20_000_000,
    },
  });
  assert.equal(malformedChecksum.missingCoreMetadata, true);
  assert.equal(malformedChecksum.required.length, 0);

  const malformedHints = expectedArtifactRequirements({
    id: "build-4",
    blockCount: 600_000,
    voxelByteSize: 20_000_000,
    voxelCompressedByteSize: 500,
    voxelSha256: checksum,
    arenaBuildHints: { deliveryClass: "snapshot" },
  });
  assert.equal(
    malformedHints.missingCoreMetadata,
    true,
    "unparsable persisted hints must require metadata repair",
  );

  assert.deepEqual(
    getArenaBuildPayloadIdentity({
      id: "checksum-less-storage-build",
      gridSize: 256,
      palette: "simple",
      blockCount: 20_000,
      voxelByteSize: 750_000,
      voxelCompressedByteSize: 125_000,
      voxelSha256: null,
      voxelStorageBucket: "builds",
      voxelStoragePath: "imports/old.json.gz",
      voxelStorageEncoding: "gzip",
    }),
    {
      id: "checksum-less-storage-build",
      gridSize: 256,
      palette: "simple",
      blockCount: 20_000,
      voxelByteSize: 750_000,
      voxelCompressedByteSize: 125_000,
      voxelSha256: null,
      voxelStorageBucket: "builds",
      voxelStoragePath: "imports/old.json.gz",
      voxelStorageEncoding: "gzip",
    },
    "checksum-less maintenance writes must retain the observed storage identity",
  );
  assert.deepEqual(
    getArenaBuildPayloadIdentity({
      id: "checksummed-storage-build",
      gridSize: 256,
      palette: "simple",
      blockCount: 20_000,
      voxelByteSize: 750_000,
      voxelCompressedByteSize: 125_000,
      voxelSha256: checksum,
      voxelStorageBucket: "builds",
      voxelStoragePath: "imports/current.json.gz",
      voxelStorageEncoding: "gzip",
    }),
    { id: "checksummed-storage-build", voxelSha256: checksum },
    "durable checksums should remain the complete payload identity",
  );
  assert.deepEqual(ARENA_BUILD_DERIVED_METADATA_RESET, {
    arenaBuildHints: Prisma.DbNull,
  });
  assert.equal(
    parsePersistedArenaBuildMetadata({
      voxelSha256: checksum,
      arenaBuildHints: ARENA_BUILD_DERIVED_METADATA_RESET.arenaBuildHints,
    }).complete,
    false,
    "an overwritten payload must remain eligible for missing-only metadata repair",
  );

  const repairedBuild = prepareArenaBuildFromBuild(
    {
      id: "checksum-less-inline-build",
      gridSize: 256,
      palette: "simple",
      blockCount: 1,
      voxelByteSize: null,
      voxelCompressedByteSize: null,
      voxelSha256: null,
      voxelData: null,
      voxelStorageBucket: null,
      voxelStoragePath: null,
      voxelStorageEncoding: null,
    },
    { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
    { checksum: null },
  );
  assert.match(repairedBuild.checksum ?? "", /^[0-9a-f]{64}$/);
  assert.equal(
    getPreparedArenaBuildCoreMetadataUpdate(repairedBuild).voxelSha256,
    repairedBuild.checksum,
    "checksum-less builds should receive durable metadata before token issuance",
  );

  console.log("arena artifact policy coverage checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
