import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeBinaryArtifact, encodeBinaryArtifact } from "../../../lib/arena/binaryArtifact";
import {
  expectedSnapshotArtifactTargets,
} from "../../../lib/arena/buildSnapshotArtifacts";
import {
  pickBuildVariant,
  prepareArenaBuildFromBuild,
  type ArenaBuildSource,
  type PreparedArenaBuild,
} from "../../../lib/arena/buildArtifacts";
import { ARENA_MESH_FACTS_MIN_BLOCKS } from "../../../lib/arena/types";
import { createVoxelMeshFacts } from "../../../lib/voxel/meshFacts";
import {
  createPackedVoxelBlocks,
  packVoxelBlocks,
  toObjectBackedVoxelBuild,
  voxelBuildBlockCount,
  type RenderableVoxelBuild,
} from "../../../lib/voxel/packedBlocks";
import type { VoxelBlock, VoxelBuild } from "../../../lib/voxel/types";

function source(blockCount: number): ArenaBuildSource {
  return {
    id: `packed-build-${blockCount}`,
    gridSize: 256,
    palette: "simple",
    blockCount,
    voxelByteSize: null,
    voxelCompressedByteSize: null,
    voxelSha256: "a".repeat(64),
    voxelData: null,
    voxelStorageBucket: null,
    voxelStoragePath: null,
    voxelStorageEncoding: null,
  };
}

function packedBuild(blocks: VoxelBlock[]): RenderableVoxelBuild {
  return { version: "1.0", blocks: [], packed: packVoxelBlocks(blocks) };
}

function planeBlocks(count: number): VoxelBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    x: index % 128,
    y: 0,
    z: Math.floor(index / 128),
    type: "stone",
  }));
}

function packedCountBuild(count: number): RenderableVoxelBuild {
  const packed = createPackedVoxelBlocks(count);
  packed.typeNames = ["stone"];
  packed.count = count;
  return { version: "1.0", blocks: [], packed };
}

function preparedForTargets(fullBuild: RenderableVoxelBuild): PreparedArenaBuild {
  const blockCount = voxelBuildBlockCount(fullBuild);
  return {
    buildId: "packed-targets",
    payloadIdentity: { id: "packed-targets", voxelSha256: "b".repeat(64) },
    checksum: "b".repeat(64),
    fullBuild,
    previewBuild: { version: "1.0", blocks: [] },
    hints: {
      initialVariant: "full",
      initialDeliveryClass: "snapshot",
      deliveryClass: "snapshot",
      fullBlockCount: blockCount,
      previewBlockCount: 0,
      previewStride: 1,
      initialEstimatedBytes: blockCount * 34,
      fullEstimatedBytes: blockCount * 34,
    },
    buildRef: { buildId: "packed-targets", variant: "full", checksum: "b".repeat(64) },
    previewRef: { buildId: "packed-targets", variant: "preview", checksum: "b".repeat(64) },
  };
}

async function main() {
  const cube: VoxelBuild = {
    version: "1.0",
    blocks: [],
  };
  for (let x = 0; x < 4; x += 1) {
    for (let y = 0; y < 4; y += 1) {
      for (let z = 0; z < 4; z += 1) {
        cube.blocks.push({ x, y, z, type: "stone" });
      }
    }
  }

  const objectPrepared = prepareArenaBuildFromBuild(source(cube.blocks.length), cube);
  const packedPrepared = prepareArenaBuildFromBuild(
    source(cube.blocks.length),
    packedBuild(cube.blocks),
  );
  assert.equal(packedPrepared.fullBuild.blocks.length, 0);
  assert.ok(packedPrepared.fullBuild.packed);
  assert.deepEqual(
    toObjectBackedVoxelBuild(packedPrepared.fullBuild).blocks,
    objectPrepared.fullBuild.blocks,
    "packed visibility filtering must match object-backed filtering order",
  );

  const previewSource = planeBlocks(10_000);
  const objectPreview = prepareArenaBuildFromBuild(source(previewSource.length), {
    version: "1.0",
    blocks: previewSource,
  });
  const packedPreview = prepareArenaBuildFromBuild(
    source(previewSource.length),
    packedBuild(previewSource),
  );
  assert.equal(packedPreview.previewBuild.packed, undefined);
  assert.ok(packedPreview.previewBuild.blocks.length > 0);
  assert.equal(
    voxelBuildBlockCount(packedPreview.previewBuild),
    voxelBuildBlockCount(objectPreview.previewBuild),
  );
  assert.deepEqual(
    toObjectBackedVoxelBuild(packedPreview.previewBuild).blocks,
    objectPreview.previewBuild.blocks,
    "packed preview sampling must match object-backed sampling order",
  );

  const fullVariant = pickBuildVariant(packedPreview, "full");
  assert.ok(fullVariant.packed, "packed prepared builds must retain packed full variants");
  const binary = encodeBinaryArtifact({ version: fullVariant.version }, fullVariant.packed);
  assert.equal(decodeBinaryArtifact(binary).blocks.count, voxelBuildBlockCount(fullVariant));
  assert.equal(createVoxelMeshFacts(fullVariant.packed).blocks.count, voxelBuildBlockCount(fullVariant));

  const targets = expectedSnapshotArtifactTargets(
    preparedForTargets(packedCountBuild(ARENA_MESH_FACTS_MIN_BLOCKS)),
  );
  assert.ok(
    targets.some((target) => target.variant === "full" && target.format === "mesh-facts"),
    "mesh-facts eligibility must use packed block counts",
  );

  const snapshotSource = readFileSync("lib/arena/buildSnapshotArtifacts.ts", "utf8");
  assert.match(snapshotSource, /voxelBuild\.packed \?\? voxelBuild\.blocks/);
  assert.match(snapshotSource, /toObjectBackedVoxelBuild\(payload\.voxelBuild\)/);

  const generationRun = readFileSync("lib/stealth/generationRun.ts", "utf8");
  assert.match(generationRun, /buildOutput: "packed"/);
  assert.match(
    generationRun,
    /processResponse: params\.processResponse/,
  );

  console.log("packed build adapter checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
