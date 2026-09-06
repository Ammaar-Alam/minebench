import type { CustomBuildArtifact } from "@prisma/client";
import { getPalette } from "@/lib/blocks/palettes";
import {
  gzipBytes,
  jsonBytes,
  sha256Hex,
  uploadAndRecordCustomBuildArtifact,
} from "@/lib/custom-builds/artifacts";
import { encodeBinaryVoxelBuild } from "@/lib/voxel/binaryBuild";
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
  type VoxelWorldRegion,
  type VoxelWorldRegionPage,
  type VoxelWorldRegionPageRef,
} from "@/lib/voxel/world";
import {
  evaluateVoxelWorldRegions,
  type MixedVoxelWorldRegion,
  type VoxelWorldRegion as EvaluatedVoxelWorldRegion,
} from "@/lib/voxel/worldRegions";

type PersistArtifact = typeof uploadAndRecordCustomBuildArtifact;
type PaletteName = "simple" | "advanced";

const PAGE_KEY_PREFIX = "page-";

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

function storedPartRef(key: string, artifact: CustomBuildArtifact): StoredVoxelWorldPartRef {
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
  persistArtifact: PersistArtifact;
  customBuildId: string;
  publicId: string;
  sourceBuildSha256: string;
  key: string;
  bytes: Uint8Array;
  uncompressedByteSize: number;
  blockCount: number;
  role: "mixed_region" | "region_page" | "manifest";
  index?: number;
}): Promise<CustomBuildArtifact> {
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

export async function persistVoxelWorldArtifacts(args: {
  customBuildId: string;
  publicId: string;
  sourceBuildSha256: string;
  sourceBuild: VoxelBuild;
  gridSize: number;
  palette: PaletteName;
  previewTargetBlocks: number;
  persistArtifact?: PersistArtifact;
  throwIfCanceled?: () => void;
}): Promise<{
  manifest: VoxelWorldManifest;
  previewBuild: VoxelBuild;
  manifestArtifact: CustomBuildArtifact;
}> {
  const persistArtifact = args.persistArtifact ?? uploadAndRecordCustomBuildArtifact;
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
  const mixedPartsBySha = new Map<string, StoredVoxelWorldPartRef>();

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

  for (const region of evaluated.regions) {
    args.throwIfCanceled?.();
    exactBlockCount += region.blockCount;
    bounds = extendBounds(bounds, region.origin, region.size);
    if (region.kind === "uniform") {
      appendUniformPreviewBlocks(previewBlocks, region, args.previewTargetBlocks);
      await pushRegion({
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
    const bytes = encodeBinaryVoxelBuild(mixedRegionBlocks(region, paletteIds), args.sourceBuildSha256);
    const gzip = gzipBytes(bytes);
    const gzipSha = sha256Hex(gzip);
    const key = `mixed-${gzipSha}`;
    let data = mixedPartsBySha.get(gzipSha);
    if (!data) {
      const artifact = await persistBytes({
        persistArtifact,
        customBuildId: args.customBuildId,
        publicId: args.publicId,
        sourceBuildSha256: args.sourceBuildSha256,
        key,
        bytes: gzip,
        uncompressedByteSize: bytes.byteLength,
        blockCount: region.blockCount,
        role: "mixed_region",
      });
      data = storedPartRef(key, artifact);
      mixedPartsBySha.set(gzipSha, data);
    }
    await pushRegion({
      kind: "mixed",
      key: regionKey("mixed", region.origin, region.size),
      origin: region.origin,
      size: region.size,
      blockCount: region.blockCount,
      format: "mbv4",
      coordinateSpace: "local",
      data,
    });
  }
  await flushPage();

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
  };
}
