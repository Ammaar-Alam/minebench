import assert from "node:assert/strict";

async function main() {
  process.env.ARENA_SNAPSHOT_ARTIFACTS_ENABLED = "0";
  process.env.ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED = "0";
  process.env.ARENA_STREAM_ARTIFACTS_ENABLED = "0";

  const { deleteArenaBuildArtifacts } = await import("../../../lib/arena/artifactOwnership");

  const deleted: Array<Array<{ bucket: string; path: string }>> = [];
  const deletion = await deleteArenaBuildArtifacts({
    retiringBuilds: [{ id: "build-a", voxelSha256: "checksum-a" }],
    survivingChecksums: new Set(),
    deleteStorage: async (refs) => {
      deleted.push(refs);
    },
  });

  assert.deepEqual(deletion, { deleted: 8, preserved: 0 });
  assert.equal(deleted.length, 1);
  assert.equal(new Set(deleted[0].map((ref) => `${ref.bucket}:${ref.path}`)).size, 8);
  assert.equal(deleted[0].filter((ref) => ref.path.endsWith(".json")).length, 2);
  assert.equal(deleted[0].filter((ref) => ref.path.endsWith(".mbv4")).length, 2);
  assert.equal(
    deleted[0].filter((ref) => ref.path.includes("/build-a/") && ref.path.endsWith(".ndjson"))
      .length,
    2,
  );
  assert.equal(
    deleted[0].filter(
      (ref) => ref.path.includes("/checksum/checksum-a/") && ref.path.endsWith(".ndjson"),
    ).length,
    2,
  );

  const preservedRefs: Array<{ bucket: string; path: string }> = [];
  const preserved = await deleteArenaBuildArtifacts({
    retiringBuilds: [
      { id: "build-b", voxelSha256: "checksum-shared" },
      { id: "build-b", voxelSha256: "checksum-shared" },
    ],
    survivingChecksums: new Set(["checksum-shared"]),
    deleteStorage: async (refs) => {
      preservedRefs.push(...refs);
    },
  });

  assert.deepEqual(preserved, { deleted: 6, preserved: 2 });
  assert.equal(new Set(preservedRefs.map((ref) => `${ref.bucket}:${ref.path}`)).size, 6);
  assert.equal(preservedRefs.some((ref) => ref.path.includes("/checksum/checksum-shared/")), false);

  await assert.rejects(
    deleteArenaBuildArtifacts({
      retiringBuilds: [{ id: "build-c", voxelSha256: "checksum-c" }],
      survivingChecksums: new Set(),
      deleteStorage: async () => {
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
