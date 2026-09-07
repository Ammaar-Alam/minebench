import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as THREE from "three";

import { getPalette } from "../../../lib/blocks/palettes";
import { decodeBinaryVoxelBuild } from "../../../lib/voxel/binaryBuild";
import {
  createLocalVoxelWorldForTest,
  type LocalVoxelWorldProgress,
} from "../../../lib/voxel/localWorld";
import { createVoxelWorldScene } from "../../../lib/voxel/worldScene";
import { getWorldMeshVersion } from "../../../lib/voxel/worldMesh";

function packedHasBlock(
  packed: ReturnType<typeof decodeBinaryVoxelBuild>,
  x: number,
  y: number,
  z: number,
  type: string,
): boolean {
  const typeId = packed.typeNames.indexOf(type);
  if (typeId < 0) return false;
  for (let index = 0; index < packed.count; index += 1) {
    if (
      packed.typeIds[index] === typeId &&
      packed.positions[index * 3] === x &&
      packed.positions[index * 3 + 1] === y &&
      packed.positions[index * 3 + 2] === z
    ) {
      return true;
    }
  }
  return false;
}

function overviewAxisStart(index: number): number {
  return index === 31 ? 2016 : index * 64;
}

async function main() {
  const overviewBoxes = Array.from({ length: 32 * 32 }, (_, index) => {
    const x = overviewAxisStart(index % 32);
    const z = overviewAxisStart(Math.floor(index / 32));
    return { x1: x, y1: 0, z1: z, x2: x + 31, y2: 31, z2: z + 31, type: index === 32 * 32 - 1 ? "bricks" : "stone" };
  });

  const full = await createLocalVoxelWorldForTest(
    {
      version: "1.0",
      blocks: [],
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 8191, y2: 8191, z2: 8191, type: "stone" }],
    },
    { gridSize: 8192, palette: "simple", worldId: "local-test-full" },
  );

  assert.equal(full.blockCount, 549_755_813_888);
  assert.equal(full.partKeys.length, 1);
  assert.ok(full.build.world?.manifest.overview);
  assert.ok(full.parts.has(full.build.world.manifest.overview.data.key));
  assert.equal(full.build.blocks.length, 0);
  assert.deepEqual(full.build.world?.manifest.regions, [
    {
      kind: "uniform",
      key: "local-test-full.region.0",
      origin: { x: 0, y: 0, z: 0 },
      size: { x: 8192, y: 8192, z: 8192 },
      type: "stone",
      blockCount: 549_755_813_888,
    },
  ]);

  const mixed = await createLocalVoxelWorldForTest(
    {
      version: "1.0",
      blocks: [{ x: 127, y: 127, z: 127, type: "glass" }],
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 127, y2: 127, z2: 127, type: "stone" }],
    },
    { gridSize: 2048, palette: "simple", worldId: "local-test-mixed" },
  );

  const mixedRegion = mixed.build.world?.manifest.regions?.find((region) => region.kind === "mixed");
  assert.equal(mixedRegion?.kind, "mixed");
  if (mixedRegion?.kind !== "mixed") throw new Error("missing mixed region");

  const bytes = mixed.parts.get(mixedRegion.data.key);
  assert.ok(bytes);
  const packed = decodeBinaryVoxelBuild(bytes);
  assert.ok(packed.count > 0);
  for (let index = 0; index < packed.count; index += 1) {
    assert.ok(packed.positions[index * 3] >= 0 && packed.positions[index * 3] < 64);
    assert.ok(packed.positions[index * 3 + 1] >= 0 && packed.positions[index * 3 + 1] < 64);
    assert.ok(packed.positions[index * 3 + 2] >= 0 && packed.positions[index * 3 + 2] < 64);
  }

  const mesh = mixed.build.world?.manifest.mesh;
  assert.ok(mesh);
  assert.equal(mesh.version, await getWorldMeshVersion());
  assert.ok(mesh.batches.length > 0);
  for (const batch of mesh.batches) {
    assert.equal(batch.data.kind, "localBlob");
    assert.equal(batch.data.encoding, "gzip");
    const meshBytes = mixed.parts.get(batch.data.key);
    assert.ok(meshBytes);
    assert.equal(meshBytes[0], 0x1f);
    assert.equal(meshBytes[1], 0x8b);
  }

  const requestedMeshKeys: string[] = [];
  const previousWorker = globalThis.Worker;
  let workerCalls = 0;
  globalThis.Worker = class {
    constructor() {
      workerCalls += 1;
      throw new Error("unexpected mesh worker");
    }
  } as unknown as typeof Worker;
  try {
    const scene = await createVoxelWorldScene(
      {
        manifest: mixed.build.world!.manifest,
        resolvePart: async (key) => {
          requestedMeshKeys.push(key);
          const part = mixed.parts.get(key);
          if (!part) throw new Error(`missing local part ${key}`);
          return part;
        },
      },
      getPalette("simple"),
      new THREE.Texture(),
    );
    assert.equal(workerCalls, 0);
    assert.equal(requestedMeshKeys.length, mesh.batches.length);
    assert.equal(new Set(requestedMeshKeys).size, mesh.batches.length);
    assert.ok(requestedMeshKeys.every((key) => key.includes(".mesh.")));
    assert.equal(scene.getResidentStats().meshBatches, mesh.batches.length);
    scene.dispose();
  } finally {
    globalThis.Worker = previousWorker;
  }

  const overviewWorld = await createLocalVoxelWorldForTest(
    {
      version: "1.0",
      blocks: [],
      boxes: overviewBoxes,
    },
    { gridSize: 2048, palette: "simple", worldId: "local-test-overview" },
  );
  assert.equal(overviewWorld.blockCount, 32 * 32 * 32 ** 3);
  assert.equal(overviewWorld.build.world?.manifest.regionPages?.[0]?.regionCount, 1024);
  const overview = overviewWorld.build.world?.manifest.overview;
  assert.ok(overview);
  assert.equal(overview.scale, 32);
  const overviewBytes = overviewWorld.parts.get(overview.data.key);
  assert.ok(overviewBytes);
  const overviewPacked = decodeBinaryVoxelBuild(overviewBytes);
  assert.equal(overviewPacked.count, 1024);
  assert.ok(packedHasBlock(overviewPacked, 0, 0, 0, "stone"));
  assert.ok(packedHasBlock(overviewPacked, 63, 0, 63, "bricks"));

  const rawFileBuild = ` \n{
    "version": "1.0",
    "name": "pierre taillée",
    "boxes": ${JSON.stringify(overviewBoxes)},
    "blocks": []
  }\n`;
  const rawFileBytes = new TextEncoder().encode(rawFileBuild);
  const fileProgress: LocalVoxelWorldProgress[] = [];
  const fileWorld = await createLocalVoxelWorldForTest(
    new Blob([rawFileBytes], { type: "application/json" }),
    {
      gridSize: 2048,
      palette: "simple",
      worldId: "local-test-file",
      onProgress: (progress) => fileProgress.push(progress),
    },
  );

  assert.equal(fileWorld.blockCount, overviewWorld.blockCount);
  assert.equal(
    fileWorld.build.world?.manifest.source.sha256,
    createHash("sha256").update(rawFileBytes).digest("hex"),
  );
  assert.deepEqual(Object.keys(fileWorld.build).sort(), ["blocks", "version", "world"]);
  assert.equal(fileWorld.build.blocks.length, 0);
  assert.ok(fileProgress.some((progress) =>
    progress.stage === "reading" &&
    progress.bytesRead === rawFileBytes.byteLength &&
    progress.totalBytes === rawFileBytes.byteLength,
  ));
  const fileBuildingProgress = fileProgress.filter((progress) => progress.stage === "building");
  assert.ok(fileBuildingProgress.length > 0);
  assert.ok(fileBuildingProgress.some((progress) =>
    progress.processedBlocks !== undefined &&
    progress.totalBlocks === fileWorld.blockCount &&
    progress.processedBlocks > 0,
  ));
  assert.equal(fileBuildingProgress.at(-1)?.processedBlocks, fileWorld.blockCount);
  assert.equal(fileWorld.build.world?.manifest.regionPages?.[0]?.regionCount, 1024);
  const fileOverview = fileWorld.build.world?.manifest.overview;
  assert.ok(fileOverview);
  const fileOverviewBytes = fileWorld.parts.get(fileOverview.data.key);
  assert.ok(fileOverviewBytes);
  const fileOverviewPacked = decodeBinaryVoxelBuild(fileOverviewBytes);
  assert.equal(fileOverviewPacked.count, 1024);
  assert.ok(packedHasBlock(fileOverviewPacked, 0, 0, 0, "stone"));
  assert.ok(packedHasBlock(fileOverviewPacked, 63, 0, 63, "bricks"));

  let malformedStreamCanceled = false;
  const malformedBlob = {
    size: 1_100_000,
    stream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"version":"1.0","blocks":[{"x":"${"1".repeat(1_050_000)}`));
        },
        cancel() {
          malformedStreamCanceled = true;
        },
      });
    },
  };
  await assert.rejects(
    () => createLocalVoxelWorldForTest(
      malformedBlob,
      { gridSize: 2048, palette: "simple", worldId: "local-test-malformed" },
    ),
    /Build entry is too large/,
  );
  assert.equal(malformedStreamCanceled, true);

  const abortParts = new Map<string, Uint8Array>();
  const abortController = new AbortController();
  await assert.rejects(
    () => createLocalVoxelWorldForTest(
      {
        version: "1.0",
        blocks: [
          { x: 0, y: 0, z: 0, type: "stone" },
          { x: 1, y: 0, z: 0, type: "glass" },
        ],
      },
      {
        gridSize: 2048,
        palette: "simple",
        worldId: "local-test-abort",
        signal: abortController.signal,
        parts: abortParts,
        onPutPart: () => abortController.abort(),
      },
    ),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(abortParts.size, 0);

  const abortMeshParts = new Map<string, Uint8Array>();
  const abortMeshController = new AbortController();
  await assert.rejects(
    () => createLocalVoxelWorldForTest(
      {
        version: "1.0",
        blocks: [
          { x: 0, y: 0, z: 0, type: "stone" },
          { x: 1, y: 0, z: 0, type: "glass" },
        ],
      },
      {
        gridSize: 2048,
        palette: "simple",
        worldId: "local-test-mesh-abort",
        signal: abortMeshController.signal,
        parts: abortMeshParts,
        onPutPart: (record) => {
          if (record.key.includes(".mesh.")) abortMeshController.abort();
        },
      },
    ),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(abortMeshParts.size, 0);

  console.log("local voxel world checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
