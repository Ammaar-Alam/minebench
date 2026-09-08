import type { CustomBuildArtifact } from "@prisma/client";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants as zlibConstants, gzipSync } from "node:zlib";
import { getPalette } from "@/lib/blocks/palettes";
import {
  gzipBytes,
  jsonBytes,
  sha256Hex,
  uploadAndRecordCustomBuildArtifact,
} from "@/lib/custom-builds/artifacts";
import { encodeBinaryVoxelBuild } from "@/lib/voxel/binaryBuild";
import { encodeWorldMeshPayload, getWorldMeshVersion } from "@/lib/voxel/worldMesh";
import { buildWorldMeshPayloads } from "@/lib/voxel/worldMeshSource";
import type { VoxelBuild, VoxelBlock, VoxelPoint } from "@/lib/voxel/types";
import {
  VOXEL_WORLD_EVALUATOR_VERSION,
  VOXEL_WORLD_INLINE_REGION_LIMIT,
  VOXEL_WORLD_MANIFEST_VERSION,
  VOXEL_WORLD_MIXED_LEAF_SIZE,
  VOXEL_WORLD_REGION_PAGE_LIMIT,
  VOXEL_WORLD_REGION_PAGE_REF_LIMIT,
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  type StoredVoxelWorldPartRef,
  type VoxelWorldBounds,
  type VoxelWorldManifest,
  type VoxelWorldMesh,
  type VoxelWorldPartRef,
  type VoxelWorldRegion,
  type VoxelWorldRegionPage,
  type VoxelWorldRegionPageRef,
} from "@/lib/voxel/world";
import {
  evaluateVoxelWorldRegions,
  type MixedVoxelWorldRegion,
  type VoxelWorldRegion as EvaluatedVoxelWorldRegion,
} from "@/lib/voxel/worldRegions";
import {
  VOXEL_WORLD_OVERVIEW_SCALE,
  createVoxelWorldOverviewState,
  encodeVoxelWorldOverviewBuild,
  markMixedVoxelWorldOverviewRegion,
  markUniformVoxelWorldOverviewRegion,
} from "@/lib/voxel/worldOverview";

type PaletteName = "simple" | "advanced";
export type PersistedVoxelWorldArtifact = Pick<
  CustomBuildArtifact,
  "bucket" | "path" | "encoding" | "sha256"
> & { storedByteSize: number | bigint };
export type PersistVoxelWorldArtifact = (
  args: Parameters<typeof uploadAndRecordCustomBuildArtifact>[0],
) => Promise<PersistedVoxelWorldArtifact>;

const PAGE_KEY_PREFIX = "page-";
const OVERVIEW_PART_KEY = "overview";
const MIXED_PART_PERSIST_CONCURRENCY = 4;

export function voxelWorldPartSourceSha256(sourceBuildSha256: string, partKey: string): string {
  return sha256Hex(`${sourceBuildSha256}\0${partKey}`);
}

export function isVoxelWorldRegionPageKey(partKey: string): boolean {
  return partKey.startsWith(PAGE_KEY_PREFIX);
}

function regionKey(prefix: string, origin: VoxelPoint, size: VoxelPoint): string {
  return `${prefix}-${origin.x}-${origin.y}-${origin.z}-${size.x}-${size.y}-${size.z}`;
}

function extendBounds(bounds: VoxelWorldBounds | null, origin: VoxelPoint, size: VoxelPoint): VoxelWorldBounds {
  if (!bounds) return { origin: { ...origin }, size: { ...size } };
  const nextOrigin = {
    x: Math.min(bounds.origin.x, origin.x),
    y: Math.min(bounds.origin.y, origin.y),
    z: Math.min(bounds.origin.z, origin.z),
  };
  const nextEnd = {
    x: Math.max(bounds.origin.x + bounds.size.x, origin.x + size.x),
    y: Math.max(bounds.origin.y + bounds.size.y, origin.y + size.y),
    z: Math.max(bounds.origin.z + bounds.size.z, origin.z + size.z),
  };
  return {
    origin: nextOrigin,
    size: {
      x: nextEnd.x - nextOrigin.x,
      y: nextEnd.y - nextOrigin.y,
      z: nextEnd.z - nextOrigin.z,
    },
  };
}

function appendUniformPreviewBlocks(
  blocks: VoxelBlock[],
  region: Extract<EvaluatedVoxelWorldRegion, { kind: "uniform" }>,
  targetBlocks: number,
): void {
  const remaining = targetBlocks - blocks.length;
  if (remaining <= 0) return;
  const count = Math.min(remaining, region.blockCount);
  const stride = Math.max(1, Math.floor(region.blockCount / count));
  const sx = region.size.x;
  const sy = region.size.y;
  const plane = sx * sy;
  for (let offset = 0; blocks.length < targetBlocks && offset < region.blockCount; offset += stride) {
    blocks.push({
      x: region.origin.x + (offset % sx),
      y: region.origin.y + (Math.floor(offset / sx) % sy),
      z: region.origin.z + Math.floor(offset / plane),
      type: region.type,
    });
  }
}

function appendMixedPreviewBlocks(
  blocks: VoxelBlock[],
  region: MixedVoxelWorldRegion,
  paletteIds: string[],
  targetBlocks: number,
): void {
  const remaining = targetBlocks - blocks.length;
  if (remaining <= 0) return;
  const stride = Math.max(1, Math.floor(region.blockCount / Math.min(remaining, region.blockCount)));
  const sx = region.size.x;
  const sy = region.size.y;
  const plane = sx * sy;
  let seen = 0;
  for (let index = 0; index < region.materialIndexes.length && blocks.length < targetBlocks; index += 1) {
    const material = region.materialIndexes[index]!;
    if (material === 0) continue;
    seen += 1;
    if ((seen - 1) % stride !== 0) continue;
    blocks.push({
      x: region.origin.x + (index % sx),
      y: region.origin.y + (Math.floor(index / sx) % sy),
      z: region.origin.z + Math.floor(index / plane),
      type: paletteIds[material - 1] ?? "stone",
    });
  }
}

function mixedRegionBlocks(region: MixedVoxelWorldRegion, paletteIds: string[]): VoxelBlock[] {
  const blocks: VoxelBlock[] = [];
  const sx = region.size.x;
  const sy = region.size.y;
  const plane = sx * sy;
  for (let index = 0; index < region.materialIndexes.length; index += 1) {
    const material = region.materialIndexes[index]!;
    if (material === 0) continue;
    blocks.push({
      x: index % sx,
      y: Math.floor(index / sx) % sy,
      z: Math.floor(index / plane),
      type: paletteIds[material - 1] ?? "stone",
    });
  }
  return blocks;
}

function storedPartRef(key: string, artifact: PersistedVoxelWorldArtifact): StoredVoxelWorldPartRef {
  return {
    kind: "stored",
    key,
    bucket: artifact.bucket,
    path: artifact.path,
    encoding: artifact.encoding,
    byteSize: Number(artifact.storedByteSize),
    sha256: artifact.sha256,
  };
}

async function persistBytes(args: {
  persistArtifact: PersistVoxelWorldArtifact;
  customBuildId: string;
  publicId: string;
  sourceBuildSha256: string;
  key: string;
  bytes: Uint8Array;
  uncompressedByteSize: number;
  blockCount: number;
  role: "mixed_region" | "region_page" | "manifest" | "mesh";
  index?: number;
}): Promise<PersistedVoxelWorldArtifact> {
  const sha256 = sha256Hex(args.bytes);
  return args.persistArtifact({
    customBuildId: args.customBuildId,
    publicId: args.publicId,
    kind: args.role === "manifest" ? "viewer_world" : "world_part",
    bytes: args.bytes,
    uncompressedByteSize: args.uncompressedByteSize,
    sha256,
    sourceBuildSha256: args.role === "manifest"
      ? args.sourceBuildSha256
      : voxelWorldPartSourceSha256(args.sourceBuildSha256, args.key),
    blockCount: args.blockCount,
    exportStats: {
      worldPartKey: args.key,
      worldPartRole: args.role,
      ...(args.index === undefined ? {} : { index: args.index }),
    },
    encoding: "gzip",
  });
}

export async function persistVoxelWorldMeshArtifacts(args: {
  customBuildId: string;
  publicId: string;
  sourceBuildSha256: string;
  regions: readonly VoxelWorldRegion[];
  palette: PaletteName;
  readPart: (ref: VoxelWorldPartRef) => Promise<Uint8Array>;
  persistArtifact?: PersistVoxelWorldArtifact;
  throwIfCanceled?: () => void;
}): Promise<VoxelWorldMesh> {
  const persistArtifact = args.persistArtifact ?? uploadAndRecordCustomBuildArtifact;
  const paletteIds = getPalette(args.palette).map((block) => block.id);
  const mesh: VoxelWorldMesh = { version: await getWorldMeshVersion(), batches: [] };
  for await (const batch of buildWorldMeshPayloads({
    regions: args.regions,
    sourceBuildSha256: args.sourceBuildSha256,
    paletteIds,
    readPart: args.readPart,
    throwIfCanceled: args.throwIfCanceled,
  })) {
    args.throwIfCanceled?.();
    const index = mesh.batches.length;
    const bytes = encodeWorldMeshPayload(batch.payload);
    args.throwIfCanceled?.();
    const gzip = gzipSync(bytes, { level: 6 });
    args.throwIfCanceled?.();
    const key = `mesh-${mesh.version}-${index}`;
    const artifact = await persistBytes({
      persistArtifact,
      customBuildId: args.customBuildId,
      publicId: args.publicId,
      sourceBuildSha256: args.sourceBuildSha256,
      key,
      bytes: gzip,
      uncompressedByteSize: bytes.byteLength,
      blockCount: batch.blockCount,
      role: "mesh",
      index,
    });
    args.throwIfCanceled?.();
    mesh.batches.push({ bounds: batch.bounds, blockCount: batch.blockCount, data: storedPartRef(key, artifact) });
  }
  args.throwIfCanceled?.();
  return mesh;
}

export async function persistVoxelWorldArtifacts(args: {
  customBuildId: string;
  publicId: string;
  sourceBuildSha256: string;
  sourceBuild: VoxelBuild;
  consumeSource?: boolean;
  gridSize: number;
  palette: PaletteName;
  previewTargetBlocks: number;
  persistArtifact?: PersistVoxelWorldArtifact;
  throwIfCanceled?: () => void;
}): Promise<{
  manifest: VoxelWorldManifest;
  previewBuild: VoxelBuild;
  warnings: string[];
  manifestArtifact: PersistedVoxelWorldArtifact;
}> {
  const persistArtifact: PersistVoxelWorldArtifact = args.persistArtifact ?? uploadAndRecordCustomBuildArtifact;
  const palette = getPalette(args.palette);
  const paletteIds = palette.map((block) => block.id);
  const evaluated = evaluateVoxelWorldRegions(args.sourceBuild, {
    gridSize: args.gridSize,
    palette,
    mixedLeafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
  });
  if (!evaluated.ok) throw new Error(evaluated.error);

  let exactBlockCount = 0;
  let bounds: VoxelWorldBounds | null = null;
  let inlineRegions: VoxelWorldRegion[] = [];
  let pageRegions: VoxelWorldRegion[] = [];
  let pageBounds: VoxelWorldBounds | null = null;
  let pageBlockCount = 0;
  let pageIndex = 0;
  let paged = false;
  const regionPages: VoxelWorldRegionPageRef[] = [];
  const previewBlocks: VoxelBlock[] = [];
  const mixedPartsBySha = new Map<string, Promise<StoredVoxelWorldPartRef>>();
  const overview = createVoxelWorldOverviewState(args.gridSize, palette.length);
  const materialByType = new Map(paletteIds.map((type, index) => [type, index + 1]));
  const queuedRegions: Array<Promise<VoxelWorldRegion>> = [];
  const meshRegions: VoxelWorldRegion[] = [];
  let spoolDirectory: string | undefined;

  const flushPage = async () => {
    if (pageRegions.length === 0 || !pageBounds) return;
    if (pageIndex >= VOXEL_WORLD_REGION_PAGE_REF_LIMIT) {
      throw new Error("Voxel world manifest has too many region pages");
    }
    const key = `${PAGE_KEY_PREFIX}${pageIndex}`;
    const page: VoxelWorldRegionPage = {
      kind: "voxel_world_region_page",
      version: VOXEL_WORLD_MANIFEST_VERSION,
      index: pageIndex,
      bounds: pageBounds,
      regionCount: pageRegions.length,
      blockCount: pageBlockCount,
      regions: pageRegions,
    };
    const parsed = parseVoxelWorldRegionPage(page, {
      allowStoredRefs: true,
      gridSize: args.gridSize,
      worldBounds: bounds,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const bytes = jsonBytes(page);
    const artifact = await persistBytes({
      persistArtifact,
      customBuildId: args.customBuildId,
      publicId: args.publicId,
      sourceBuildSha256: args.sourceBuildSha256,
      key,
      bytes: gzipBytes(bytes),
      uncompressedByteSize: bytes.byteLength,
      blockCount: page.blockCount,
      role: "region_page",
      index: pageIndex,
    });
    regionPages.push({
      index: pageIndex,
      bounds: page.bounds,
      regionCount: page.regionCount,
      blockCount: page.blockCount,
      data: storedPartRef(key, artifact),
    });
    pageRegions = [];
    pageBounds = null;
    pageBlockCount = 0;
    pageIndex += 1;
  };

  const pushRegion = async (region: VoxelWorldRegion) => {
    meshRegions.push(region);
    if (!paged) {
      inlineRegions.push(region);
      if (inlineRegions.length <= VOXEL_WORLD_INLINE_REGION_LIMIT) return;
      paged = true;
      pageRegions = inlineRegions;
      inlineRegions = [];
      for (const pageRegion of pageRegions) {
        pageBounds = extendBounds(pageBounds, pageRegion.origin, pageRegion.size);
        pageBlockCount += pageRegion.blockCount;
      }
      if (pageRegions.length >= VOXEL_WORLD_REGION_PAGE_LIMIT) await flushPage();
      return;
    }
    pageRegions.push(region);
    pageBounds = extendBounds(pageBounds, region.origin, region.size);
    pageBlockCount += region.blockCount;
    if (pageRegions.length >= VOXEL_WORLD_REGION_PAGE_LIMIT) await flushPage();
  };

  const drainQueuedRegions = async (keepQueued: number) => {
    while (queuedRegions.length > keepQueued) {
      await pushRegion(await queuedRegions.shift()!);
    }
  };

  const queueRegion = async (region: VoxelWorldRegion | Promise<VoxelWorldRegion>) => {
    const queued = Promise.resolve(region);
    void queued.catch(() => undefined);
    queuedRegions.push(queued);
    await drainQueuedRegions(MIXED_PART_PERSIST_CONCURRENCY - 1);
  };

  try {
    for (const region of evaluated.regions) {
      args.throwIfCanceled?.();
      exactBlockCount += region.blockCount;
      bounds = extendBounds(bounds, region.origin, region.size);
      if (region.kind === "uniform") {
        const material = materialByType.get(region.type);
        if (overview && material) markUniformVoxelWorldOverviewRegion(overview, region, material);
        appendUniformPreviewBlocks(previewBlocks, region, args.previewTargetBlocks);
        await queueRegion({
          kind: "uniform",
          key: regionKey("uniform", region.origin, region.size),
          origin: region.origin,
          size: region.size,
          type: region.type,
          blockCount: region.blockCount,
        });
        continue;
      }

      appendMixedPreviewBlocks(previewBlocks, region, paletteIds, args.previewTargetBlocks);
      if (overview) markMixedVoxelWorldOverviewRegion(overview, region);
      const bytes = encodeBinaryVoxelBuild(mixedRegionBlocks(region, paletteIds), args.sourceBuildSha256);
      const gzip = gzipSync(bytes, { level: zlibConstants.Z_BEST_SPEED });
      const gzipSha = sha256Hex(gzip);
      const key = `mixed-${gzipSha}`;
      let data = mixedPartsBySha.get(gzipSha);
      if (!data) {
        spoolDirectory ??= await mkdtemp(join(tmpdir(), "minebench-world-mesh-"));
        await writeFile(join(spoolDirectory, key), bytes);
        args.throwIfCanceled?.();
        data = persistBytes({
          persistArtifact,
          customBuildId: args.customBuildId,
          publicId: args.publicId,
          sourceBuildSha256: args.sourceBuildSha256,
          key,
          bytes: gzip,
          uncompressedByteSize: bytes.byteLength,
          blockCount: region.blockCount,
          role: "mixed_region",
        }).then((artifact) => storedPartRef(key, artifact));
        mixedPartsBySha.set(gzipSha, data);
      }
      await queueRegion(data.then((partRef) => ({
        kind: "mixed",
        key: regionKey("mixed", region.origin, region.size),
        origin: region.origin,
        size: region.size,
        blockCount: region.blockCount,
        format: "mbv4",
        coordinateSpace: "local",
        data: partRef,
      })));
    }
    await drainQueuedRegions(0);
    evaluated.regions = [];
    if (args.consumeSource) {
      args.sourceBuild.blocks.length = 0;
      if (args.sourceBuild.boxes) args.sourceBuild.boxes.length = 0;
      if (args.sourceBuild.lines) args.sourceBuild.lines.length = 0;
      delete args.sourceBuild.packed;
    }
    await flushPage();

    let overviewData: StoredVoxelWorldPartRef | undefined;
    if (overview && exactBlockCount > 0) {
      const overviewBuild = encodeVoxelWorldOverviewBuild(overview, paletteIds, args.sourceBuildSha256);
      const overviewBytes = gzipBytes(overviewBuild.bytes);
      const artifact = await persistBytes({
        persistArtifact,
        customBuildId: args.customBuildId,
        publicId: args.publicId,
        sourceBuildSha256: args.sourceBuildSha256,
        key: OVERVIEW_PART_KEY,
        bytes: overviewBytes,
        uncompressedByteSize: overviewBuild.bytes.byteLength,
        blockCount: overviewBuild.blockCount,
        role: "mixed_region",
      });
      overviewData = storedPartRef(OVERVIEW_PART_KEY, artifact);
    }

    const mesh = await persistVoxelWorldMeshArtifacts({
      customBuildId: args.customBuildId,
      publicId: args.publicId,
      sourceBuildSha256: args.sourceBuildSha256,
      regions: meshRegions,
      palette: args.palette,
      readPart: async (ref) => {
        if (!spoolDirectory) throw new Error("Voxel world mesh source is missing");
        return readFile(join(spoolDirectory, ref.key));
      },
      persistArtifact,
      throwIfCanceled: args.throwIfCanceled,
    });
    args.throwIfCanceled?.();
    const manifest: VoxelWorldManifest = {
      kind: "voxel_world",
      version: VOXEL_WORLD_MANIFEST_VERSION,
      gridSize: args.gridSize,
      palette: args.palette,
      bounds,
      exactBlockCount,
      leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
      source: {
        format: "voxel-build-json",
        sha256: args.sourceBuildSha256,
        evaluatorVersion: VOXEL_WORLD_EVALUATOR_VERSION,
      },
      mesh,
      ...(overviewData ? { overview: { data: overviewData, scale: VOXEL_WORLD_OVERVIEW_SCALE } } : {}),
      ...(paged ? { regionPages } : { regions: inlineRegions }),
    };
    const parsed = parseVoxelWorldManifest(manifest, { allowStoredRefs: true });
    if (!parsed.ok) throw new Error(parsed.error);
    const manifestBytes = jsonBytes(manifest);
    const manifestArtifact = await persistBytes({
      persistArtifact,
      customBuildId: args.customBuildId,
      publicId: args.publicId,
      sourceBuildSha256: args.sourceBuildSha256,
      key: "manifest",
      bytes: gzipBytes(manifestBytes),
      uncompressedByteSize: manifestBytes.byteLength,
      blockCount: exactBlockCount,
      role: "manifest",
    });

    return {
      manifest,
      manifestArtifact,
      previewBuild: { version: "1.0", blocks: previewBlocks },
      warnings: evaluated.warnings,
    };
  } finally {
    await Promise.allSettled(queuedRegions);
    if (spoolDirectory) await rm(spoolDirectory, { recursive: true, force: true });
  }
}
