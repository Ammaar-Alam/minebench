import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { decodeBinaryArtifact, encodeBinaryArtifact } from "../../../lib/arena/binaryArtifact";
import { buildGalleryPreviewSvg } from "../../../lib/gallery/preview";
import {
  persistVoxelWorldArtifacts,
  type PersistVoxelWorldArtifact,
} from "../../../lib/custom-builds/worldArtifacts";
import type { VoxelBuild, VoxelBlock } from "../../../lib/voxel/types";
import type { VoxelWorldRegionPage } from "../../../lib/voxel/world";

const CUSTOM_BUILD_ID = "custom-build-row";
const PUBLIC_ID = "cb_123456789012345678901234";
const SOURCE_SHA = "a".repeat(64);
const MIXED_LEAF_SIZE = 64;

type ArtifactArgs = Parameters<PersistVoxelWorldArtifact>[0];
type PendingUpload = {
  key: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function mixedRegionBase(index: number): { x: number; z: number } {
  return {
    x: (index % 128) * MIXED_LEAF_SIZE,
    z: Math.floor(index / 128) * MIXED_LEAF_SIZE,
  };
}

function uniqueMixedBlockPair(index: number): [VoxelBlock, VoxelBlock] {
  const base = mixedRegionBase(index);
  return [
    { x: base.x, y: 0, z: base.z, type: "stone" },
    {
      x: base.x + 1 + (index % 63),
      y: Math.floor(index / 63) % 63,
      z: base.z,
      type: "cobblestone",
    },
  ];
}

function repeatedMixedBlockPair(index: number): [VoxelBlock, VoxelBlock] {
  const base = mixedRegionBase(index);
  return [
    { x: base.x, y: 0, z: base.z, type: "stone" },
    { x: base.x + 1, y: 0, z: base.z, type: "cobblestone" },
  ];
}

function mixedBuild(count: number, blockPair: (index: number) => [VoxelBlock, VoxelBlock]): VoxelBuild {
  return {
    version: "1.0",
    blocks: Array.from({ length: count }, (_, index) => blockPair(index)).flat(),
  };
}

function worldPartKey(args: ArtifactArgs): string {
  const stats = args.exportStats;
  assert.ok(stats && typeof stats === "object" && !Array.isArray(stats));
  const key = (stats as { worldPartKey?: unknown }).worldPartKey;
  if (typeof key !== "string") throw new Error("worldPartKey is required");
  return key;
}

function worldPartRole(args: ArtifactArgs): string {
  const stats = args.exportStats;
  assert.ok(stats && typeof stats === "object" && !Array.isArray(stats));
  const role = (stats as { worldPartRole?: unknown }).worldPartRole;
  if (typeof role !== "string") throw new Error("worldPartRole is required");
  return role;
}

function artifactFor(args: ArtifactArgs) {
  const key = worldPartKey(args);
  assert.ok(args.sha256);
  return {
    bucket: "unit",
    path: key,
    encoding: args.encoding ?? "identity",
    sha256: args.sha256,
    storedByteSize: args.bytes?.byteLength ?? args.storedByteSize ?? 0,
  };
}

function delayedPersistArtifact() {
  const pending: PendingUpload[] = [];
  const startedKeys: string[] = [];
  const settledKeys: string[] = [];
  const pages: VoxelWorldRegionPage[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const persistArtifact: PersistVoxelWorldArtifact = async (args) => {
    const key = worldPartKey(args);
    startedKeys.push(key);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (worldPartRole(args) === "mixed_region" && key.startsWith("mixed-")) {
        await new Promise<void>((resolve, reject) => {
          pending.push({ key, resolve, reject });
        });
      }
      if (worldPartRole(args) === "region_page") {
        assert.ok(args.bytes);
        pages.push(JSON.parse(gunzipSync(args.bytes).toString("utf8")) as VoxelWorldRegionPage);
      }
      return artifactFor(args);
    } finally {
      inFlight -= 1;
      settledKeys.push(key);
    }
  };

  return {
    pending,
    startedKeys,
    settledKeys,
    pages,
    get maxInFlight() {
      return maxInFlight;
    },
    persistArtifact,
  };
}

async function immediatePageRegionKeys(sourceBuild: VoxelBuild): Promise<string[]> {
  const pages: VoxelWorldRegionPage[] = [];
  await persistWorld(sourceBuild, async (args) => {
    if (worldPartRole(args) === "region_page") {
      assert.ok(args.bytes);
      pages.push(JSON.parse(gunzipSync(args.bytes).toString("utf8")) as VoxelWorldRegionPage);
    }
    return artifactFor(args);
  });
  return pages.flatMap((page) => page.regions.map((region) => region.key));
}

async function resolveUploadsOutOfOrder<T>(
  run: Promise<T>,
  state: ReturnType<typeof delayedPersistArtifact>,
): Promise<T> {
  let settled = false;
  const deadline = Date.now() + 60_000;
  const observed = run.finally(() => {
    settled = true;
  });
  void observed.catch(() => undefined);
  while (!settled) {
    if (state.pending.length === 0) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for artifact persistence");
      await wait(1);
      continue;
    }
    const batch = state.pending.splice(0);
    for (const upload of batch.reverse()) upload.resolve();
    await tick();
  }
  return observed;
}

function persistWorld(
  sourceBuild: VoxelBuild,
  persistArtifact: PersistVoxelWorldArtifact,
  throwIfCanceled?: () => void,
  previewTargetBlocks = 16,
) {
  return persistVoxelWorldArtifacts({
    customBuildId: CUSTOM_BUILD_ID,
    publicId: PUBLIC_ID,
    sourceBuildSha256: SOURCE_SHA,
    sourceBuild,
    gridSize: 8192,
    palette: "simple",
    previewTargetBlocks,
    persistArtifact,
    throwIfCanceled,
  });
}

async function distributePreviewAcrossRegions() {
  const farBox = { x1: 1536, y1: 0, z1: 0, x2: 2047, y2: 63, z2: 63, type: "gold_block" };
  const goldSvg = buildGalleryPreviewSvg({ version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "gold_block" }] });
  const goldFills = [...goldSvg.matchAll(/fill="(#[a-f0-9]+)"/g)].map((match) => match[1]!);
  const persist: PersistVoxelWorldArtifact = async (args) => artifactFor(args);
  for (const source of [
    { version: "1.0", blocks: [], boxes: [
      { x1: 0, y1: 0, z1: 0, x2: 511, y2: 63, z2: 63, type: "stone" }, farBox,
    ] },
    { version: "1.0", boxes: [farBox], blocks: Array.from({ length: 4096 }, (_, index) => ({
      x: index % 64, y: 0, z: Math.floor(index / 64), type: index % 2 === 0 ? "stone" : "glass",
    })) },
  ] satisfies VoxelBuild[]) {
    const { previewBuild, manifest } = await persistWorld(source, persist);
    assert.equal(manifest.regions?.length, 2);
    assert.equal(previewBuild.blocks.length, 16);
    assert.equal(previewBuild.blocks.filter((block) => block.x < 512).length, 8);
    assert.equal(previewBuild.blocks.filter((block) => block.x >= 1536).length, 8,
      "a full first region must not consume the later region's preview budget");
    const binary = decodeBinaryArtifact(encodeBinaryArtifact({ version: "1.0", variant: "preview" }, previewBuild.blocks, SOURCE_SHA));
    assert.ok(binary.blocks.typeNames.includes("gold_block"));
    const svg = buildGalleryPreviewSvg(previewBuild);
    assert.ok(goldFills.some((fill) => svg.includes(`fill="${fill}"`)));
    assert.deepEqual((await persistWorld(source, persist)).previewBuild, previewBuild);
    assert.equal((await persistWorld(source, persist, undefined, 0)).previewBuild.blocks.length, 0);
  }
  const small = await persistWorld({ version: "1.0", boxes: [
    { x1: 0, y1: 0, z1: 0, x2: 9, y2: 0, z2: 0, type: "stone" },
  ], blocks: [{ x: 1536, y: 0, z: 0, type: "gold_block" }] }, persist);
  assert.equal(small.previewBuild.blocks.length, 11, "worlds that fit the budget should retain every block");
  const many = await persistWorld(mixedBuild(32, repeatedMixedBlockPair), persist);
  assert.equal(many.previewBuild.blocks.length, 16);
  assert.equal(Math.min(...many.previewBuild.blocks.map((block) => block.x)), 0);
  assert.equal(Math.max(...many.previewBuild.blocks.map((block) => block.x)), 31 * MIXED_LEAF_SIZE,
    "when regions outnumber samples, selection must span the complete region list");
}

async function preserveOrderWithConcurrentUploads() {
  const sourceBuild = mixedBuild(2052, uniqueMixedBlockPair);
  const expectedRegionKeys = await immediatePageRegionKeys(sourceBuild);
  const state = delayedPersistArtifact();
  const result = await resolveUploadsOutOfOrder(
    persistWorld(sourceBuild, state.persistArtifact),
    state,
  );
  assert.ok(state.maxInFlight <= 4);
  assert.ok(state.startedKeys.filter((key) => key.startsWith("mixed-")).length > 4);
  assert.equal(result.manifest.regionPages?.length, 2);
  assert.equal(state.pages.length, 2);
  assert.deepEqual(
    state.pages.flatMap((page) => page.regions.map((region) => region.key)),
    expectedRegionKeys,
  );
  assert.deepEqual(
    state.startedKeys.filter((key) => !key.startsWith("mesh-")).slice(-2).map((key) => key.startsWith("page-") ? "page" : key),
    ["page", "manifest"],
  );
  assert.equal(state.startedKeys.at(-1), "manifest");
  assert.ok(!state.startedKeys.includes("overview"));
  assert.equal(state.startedKeys.filter((key) => key.startsWith("mesh-")).length, result.manifest.mesh?.batches.length);
}

async function dedupePendingMixedUploads() {
  const state = delayedPersistArtifact();
  const run = persistWorld(mixedBuild(8, repeatedMixedBlockPair), state.persistArtifact);
  void run.catch(() => undefined);
  await waitFor(() => state.pending.length === 1, "first pending duplicate upload");
  await tick();
  assert.equal(state.startedKeys.filter((key) => key.startsWith("mixed-")).length, 1);
  const result = await resolveUploadsOutOfOrder(run, state);
  const regions = result.manifest.regions?.filter((region) => region.kind === "mixed") ?? [];
  assert.equal(regions.length, 8);
  assert.equal(new Set(regions.map((region) => region.data.key)).size, 1);
  assert.equal(state.startedKeys.filter((key) => key.startsWith("mixed-")).length, 1);
}

async function drainQueuedUploadsAfterFailure() {
  const state = delayedPersistArtifact();
  const run = persistWorld(mixedBuild(8, uniqueMixedBlockPair), state.persistArtifact);
  void run.catch(() => undefined);
  await waitFor(() => state.pending.length === 4, "four pending uploads");
  const [first, ...rest] = state.pending.splice(0);
  assert.ok(first);
  setTimeout(() => {
    for (const upload of rest) upload.resolve();
  }, 20);
  first.reject(new Error("mixed upload failed"));
  await assert.rejects(run, /mixed upload failed/);
  assert.equal(state.startedKeys.filter((key) => key.startsWith("mixed-")).length, 4);
  assert.equal(state.settledKeys.filter((key) => key.startsWith("mixed-")).length, 4);
  assert.equal(state.maxInFlight, 4);
}

async function drainQueuedUploadsAfterCancellation() {
  const state = delayedPersistArtifact();
  let canceled = false;
  const run = persistWorld(mixedBuild(8, uniqueMixedBlockPair), state.persistArtifact, () => {
    if (canceled) throw new DOMException("Aborted", "AbortError");
  });
  void run.catch(() => undefined);
  await waitFor(() => state.pending.length === 4, "four pending uploads");
  const [first, ...rest] = state.pending.splice(0);
  assert.ok(first);
  canceled = true;
  setTimeout(() => {
    for (const upload of rest) upload.resolve();
  }, 20);
  first.resolve();
  await assert.rejects(run, /Aborted/);
  assert.equal(state.startedKeys.filter((key) => key.startsWith("mixed-")).length, 4);
  assert.equal(state.settledKeys.filter((key) => key.startsWith("mixed-")).length, 4);
  assert.equal(state.maxInFlight, 4);
}

async function main() {
  await distributePreviewAcrossRegions();
  await preserveOrderWithConcurrentUploads();
  await dedupePendingMixedUploads();
  await drainQueuedUploadsAfterFailure();
  await drainQueuedUploadsAfterCancellation();
  console.log("world artifact concurrency checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
