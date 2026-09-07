import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";
import { getPalette } from "../../../lib/blocks/palettes";
import { sha256Hex } from "../../../lib/custom-builds/artifacts";
import {
  persistVoxelWorldArtifacts,
  persistVoxelWorldMeshArtifacts,
  voxelWorldPartSourceSha256,
  type PersistedVoxelWorldArtifact,
  type PersistVoxelWorldArtifact,
} from "../../../lib/custom-builds/worldArtifacts";
import { decodeBinaryVoxelBuild, encodeBinaryVoxelBuild } from "../../../lib/voxel/binaryBuild";
import { createVoxelGroupFromMeshPayload } from "../../../lib/voxel/mesh";
import type { VoxelBuild } from "../../../lib/voxel/types";
import type { VoxelWorldManifest, VoxelWorldMeshBatchRef, VoxelWorldMixedRegion } from "../../../lib/voxel/world";
import { decodeWorldMeshPayload, getWorldMeshVersion } from "../../../lib/voxel/worldMesh";
import { createWorldMeshBatches, packWorldMeshBatch } from "../../../lib/voxel/worldMeshSource";
import { buildWorldRegionGreedyMeshPayload } from "../../../lib/voxel/worldRegionMesh";

const SOURCE_SHA = "a".repeat(64);
const identity = { customBuildId: "mesh-persistence-row", publicId: "cb_123456789012345678901234",
  sourceBuildSha256: SOURCE_SHA, palette: "simple" as const };
type ArtifactArgs = Parameters<PersistVoxelWorldArtifact>[0];
const sourceBuild: VoxelBuild = { version: "1.0", blocks: [
  { x: 0, y: 0, z: 0, type: "glass" }, { x: 1, y: 0, z: 0, type: "water" },
  { x: 511, y: 0, z: 0, type: "stone" }, { x: 512, y: 0, z: 0, type: "stone" },
  { x: 513, y: 0, z: 0, type: "stone" }, { x: 514, y: 0, z: 0, type: "cobblestone" },
  { x: 1024, y: 0, z: 0, type: "oak_leaves" }, { x: 1025, y: 0, z: 0, type: "glowstone" },
] };

function stats(args: ArtifactArgs): { worldPartKey: string; worldPartRole: string; index?: number } {
  return args.exportStats as ReturnType<typeof stats>;
}

function artifactFor(args: ArtifactArgs): PersistedVoxelWorldArtifact {
  assert.ok(args.bytes);
  assert.equal(args.encoding, "gzip");
  assert.equal(args.sha256, sha256Hex(args.bytes));
  assert.equal(args.uncompressedByteSize, gunzipSync(args.bytes).length);
  const key = stats(args).worldPartKey;
  assert.equal(args.sourceBuildSha256, args.kind === "viewer_world"
    ? SOURCE_SHA : voxelWorldPartSourceSha256(SOURCE_SHA, key));
  return { bucket: "unit", path: key, encoding: "gzip" as const, sha256: args.sha256,
    storedByteSize: args.bytes.length };
}

async function nativePersistence(tempRoot: string) {
  for (const mode of ["success", "source-failure", "mesh-failure", "manifest-failure", "cancel-before-mesh", "cancel-after-mesh"] as const) {
    const saved = new Map<string, ArtifactArgs>();
    let canceled = false;
    const persistArtifact: PersistVoxelWorldArtifact = async (args) => {
      const { worldPartKey: key, worldPartRole: role } = stats(args);
      if (role === "mixed_region" && key.startsWith("mixed-") && mode === "source-failure") {
        throw new Error("source persistence failed");
      }
      if (role === "mesh") {
        const directories = await readdir(tempRoot);
        assert.equal(directories.length, 1);
        const spooled = await readdir(join(tempRoot, directories[0]!));
        assert.deepEqual(spooled.sort(), [...saved.keys()].filter((part) => part.startsWith("mixed-")).sort(),
          "meshing should read one local source file per unique persisted mixed part");
        if (mode === "mesh-failure") throw new Error("mesh persistence failed");
        if (mode === "cancel-after-mesh") canceled = true;
      }
      if (key === "overview" && mode === "cancel-before-mesh") canceled = true;
      if (role === "manifest") {
        assert.ok(args.bytes);
        const manifest = JSON.parse(gunzipSync(args.bytes).toString("utf8")) as VoxelWorldManifest;
        assert.ok(manifest.mesh && manifest.mesh.batches.length >= 2);
        for (const batch of manifest.mesh.batches) {
          assert.equal(stats(saved.get(batch.data.key)!).worldPartRole, "mesh",
            "every referenced mesh must finish persistence before the ready manifest");
        }
        if (mode === "manifest-failure") throw new Error("manifest persistence failed");
      }
      const artifact = artifactFor(args);
      saved.set(key, args);
      return artifact;
    };
    const run = persistVoxelWorldArtifacts({ ...identity, sourceBuild, gridSize: 2048,
      previewTargetBlocks: 16, persistArtifact,
      throwIfCanceled: () => { if (canceled) throw new DOMException("Aborted", "AbortError"); },
    });
    if (mode !== "success") {
      await assert.rejects(run, /persistence failed|Aborted/);
      assert.equal(saved.has("manifest"), false, "failed or canceled meshing must not publish a ready manifest");
    } else {
      const { manifest } = await run;
      assert.equal(manifest.exactBlockCount, sourceBuild.blocks.length);
      assert.equal(manifest.mesh?.version, await getWorldMeshVersion());
      assert.equal([...saved.keys()].at(-1), "manifest");
      const batches = createWorldMeshBatches(manifest.regions!);
      assert.equal(manifest.mesh!.batches.length, batches.length);
      const parts = new Map(manifest.regions!.flatMap((region) => region.kind === "mixed"
        ? [[region.key, decodeBinaryVoxelBuild(gunzipSync(saved.get(region.data.key)!.bytes!))] as const] : []));
      const texture = new THREE.Texture();
      try {
        for (const [index, batch] of batches.entries()) {
          const meshBatch = manifest.mesh!.batches[index];
          assert.ok(meshBatch);
          const reference: VoxelWorldMeshBatchRef = meshBatch;
          assert.deepEqual(reference.bounds, batch.bounds);
          const { packed, halo } = packWorldMeshBatch(batch, parts);
          const expected = buildWorldRegionGreedyMeshPayload(packed, getPalette("simple").map((block) => block.id),
            { size: batch.bounds.size, halo });
          const decoded = decodeWorldMeshPayload(gunzipSync(saved.get(reference.data.key)!.bytes!));
          assert.deepEqual(decoded, expected, "stored geometry must retain every quad, bounds, and halo-derived AO value");
          assert.equal(reference.blockCount, packed.count);
          const rendered = createVoxelGroupFromMeshPayload(decoded, texture);
          const expectedQuads = Object.values(decoded.worldQuads!).reduce((sum, value) =>
            sum + (value instanceof Uint32Array ? value.length / 4 : 0), 0);
          const renderedQuads = rendered.group.children.reduce((sum, child) =>
            sum + (child instanceof THREE.Mesh && child.geometry instanceof THREE.InstancedBufferGeometry
              ? child.geometry.instanceCount : 0), 0);
          assert.equal(renderedQuads, expectedQuads);
          assert.equal(rendered.stats.blockCount, decoded.filteredBlockCount);
          rendered.dispose();
        }
      } finally { texture.dispose(); }
    }
    assert.deepEqual(await readdir(tempRoot), [], `${mode} must remove all temporary source files`);
  }
}

async function reusableHelper() {
  const bytes = encodeBinaryVoxelBuild([
    { x: 0, y: 0, z: 0, type: "stone" }, { x: 0, y: 1, z: 0, type: "cobblestone" },
  ], SOURCE_SHA);
  const regions: VoxelWorldMixedRegion[] = [511, 512].map((x) => ({
    kind: "mixed", key: `region-${x}`, origin: { x, y: 0, z: 0 }, size: { x: 1, y: 2, z: 1 },
    blockCount: 2, format: "mbv4", coordinateSpace: "local",
    data: { kind: "stored", key: "shared-source", bucket: "unit", path: "shared-source",
      encoding: "identity", byteSize: bytes.length, sha256: sha256Hex(bytes) },
  }));
  let reads = 0;
  let uploads = 0;
  let release = () => {};
  let started = () => {};
  const heldUpload = new Promise<void>((resolve) => { release = resolve; });
  const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
  const run = persistVoxelWorldMeshArtifacts({ ...identity, regions,
    readPart: async () => { reads += 1; return bytes; },
    persistArtifact: async (args) => {
      uploads += 1;
      if (uploads === 1) { started(); await heldUpload; }
      return artifactFor(args);
    },
  });
  await uploadStarted;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1, "shared source and halo data should be decoded once within a batch");
    assert.equal(uploads, 1, "the next batch must wait for the current mesh upload");
  } finally { release(); }
  const mesh = await run;
  assert.equal(reads, 2);
  assert.equal(uploads, 2);
  assert.equal(mesh.batches.reduce((sum, batch) => sum + batch.blockCount, 0), 4);

  for (const mode of ["count", "checksum", "read-failure", "canceled"] as const) {
    let canceled = false;
    let persisted = 0;
    const invalid = bytes.slice();
    const header = new DataView(invalid.buffer);
    if (mode === "checksum") header.setUint32(12, 0, false);
    await assert.rejects(persistVoxelWorldMeshArtifacts({ ...identity,
      regions: mode === "count" ? regions.map((region) => ({ ...region, blockCount: 3 })) : regions,
      readPart: async () => {
        if (mode === "read-failure") throw new Error("source read failed");
        if (mode === "canceled") canceled = true;
        return invalid;
      },
      persistArtifact: async (args) => { persisted += 1; return artifactFor(args); },
      throwIfCanceled: () => { if (canceled) throw new DOMException("Aborted", "AbortError"); },
    }), /block count mismatch|source checksum mismatch|source read failed|Aborted/);
    assert.equal(persisted, 0, `${mode} must stop before any mesh artifact is saved`);
  }
}

async function main() {
  const originalTemp = process.env.TMPDIR;
  const tempRoot = await mkdtemp(join(tmpdir(), "minebench-world-mesh-test-"));
  process.env.TMPDIR = tempRoot;
  try {
    await nativePersistence(tempRoot);
    await reusableHelper();
  } finally {
    if (originalTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTemp;
    await rm(tempRoot, { recursive: true, force: true });
  }
  console.log("world mesh persistence checks passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
