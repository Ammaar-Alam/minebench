import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function main() {
  process.env.ARENA_SNAPSHOT_ARTIFACTS_ENABLED = "0";
  process.env.ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED = "0";
  process.env.ARENA_STREAM_ARTIFACTS_ENABLED = "0";

  const artifactOwnership = readFileSync("lib/arena/artifactOwnership.ts", "utf8");
  assert.match(artifactOwnership, /compensateArtifactUpload/);
  assert.match(artifactOwnership, /catch \(error\)[\s\S]*compensateArtifactUpload/);
  const { deleteArenaBuildArtifacts } = await import("../../../lib/arena/artifactOwnership");
  const noRegisteredArtifacts = { retiringRefs: [], survivingRefKeys: new Set<string>() };

  const deleted: Array<Array<{ bucket: string; path: string }>> = [];
  const deletion = await deleteArenaBuildArtifacts({
    retiringBuilds: [{ id: "build-a", voxelSha256: "checksum-a" }],
    survivingChecksums: new Set(),
    registeredOwnership: noRegisteredArtifacts,
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
    registeredOwnership: noRegisteredArtifacts,
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
      registeredOwnership: noRegisteredArtifacts,
      deleteStorage: async () => {
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/,
  );

  const previousNamespaceRefs: Array<{ bucket: string; path: string }> = [];
  const previousNamespace = await deleteArenaBuildArtifacts({
    retiringBuilds: [{ id: "build-d", voxelSha256: "checksum-d" }],
    survivingChecksums: new Set(),
    registeredOwnership: {
      retiringRefs: [
        { bucket: "previous-bucket", path: "previous-snapshots/build-d/full.json" },
        { bucket: "previous-bucket", path: "previous-stream/checksum/shared/full.ndjson" },
      ],
      survivingRefKeys: new Set([
        "previous-bucket:previous-stream/checksum/shared/full.ndjson",
      ]),
    },
    deleteStorage: async (refs) => {
      previousNamespaceRefs.push(...refs);
    },
  });
  assert.equal(previousNamespace.deleted, 9);
  assert.equal(previousNamespace.preserved, 1);
  assert.equal(
    previousNamespaceRefs.some(
      (ref) => ref.bucket === "previous-bucket" && ref.path.includes("previous-snapshots"),
    ),
    true,
  );
  assert.equal(
    previousNamespaceRefs.some((ref) => ref.path.includes("previous-stream/checksum/shared")),
    false,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
