import { getPalette } from "@/lib/blocks/palettes";
import { encodeBinaryVoxelBuild } from "@/lib/voxel/binaryBuild";
import { createPackedVoxelBlocks } from "@/lib/voxel/packedBlocks";
import type { RenderableVoxelBuild } from "@/lib/voxel/packedBlocks";
import { parseVoxelBuildStream } from "@/lib/voxel/sourceStream";
import type { VoxelBuild, VoxelPoint } from "@/lib/voxel/types";
import {
  VOXEL_WORLD_EVALUATOR_VERSION,
  VOXEL_WORLD_INLINE_REGION_LIMIT,
  VOXEL_WORLD_MANIFEST_VERSION,
  VOXEL_WORLD_MIXED_LEAF_SIZE,
  VOXEL_WORLD_REGION_PAGE_LIMIT,
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  type VoxelWorldBounds,
  type VoxelWorldDelivery,
  type VoxelWorldManifest,
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
import { parseVoxelBuildSpec } from "@/lib/voxel/validate";

type Palette = "simple" | "advanced";

export type LocalVoxelWorldOwnership = {
  worldId: string;
  partKeys: string[];
};

export type LocalVoxelWorldResult = LocalVoxelWorldOwnership & {
  build: RenderableVoxelBuild;
  warnings: string[];
  blockCount: number;
};

export type LocalVoxelWorldProgress = {
  stage: "reading" | "building";
  bytesRead?: number;
  totalBytes?: number;
};

type LocalWorldPartRecord = {
  key: string;
  worldId: string;
  bytes: Uint8Array;
  byteSize: number;
  touchedAt: number;
};

type LocalWorldMetaRecord = {
  worldId: string;
  partKeys: string[];
  byteSize: number;
  touchedAt: number;
};

type LocalWorldStorage = {
  putPart(record: LocalWorldPartRecord): Promise<void>;
  finishWorld(record: LocalWorldMetaRecord): Promise<void>;
  cleanupWorld(ownership: LocalVoxelWorldOwnership): Promise<void>;
  prune(keepWorldId: string): Promise<void>;
};

type BlobLikeInput = {
  size?: number;
  stream(): ReadableStream<Uint8Array>;
};

type PreparedLocalVoxelWorldInput = {
  sourceBuild: VoxelBuild;
  sourceSha: string;
  buildForReturn: VoxelBuild;
  bytesRead?: number;
  totalBytes?: number;
};

const DB_NAME = "minebench-local-voxel-worlds";
const DB_VERSION = 1;
const PART_STORE = "parts";
const WORLD_STORE = "worlds";
const MAX_LOCAL_WORLD_COUNT = 6;
const MAX_LOCAL_WORLD_BYTES = 220_000_000;

let dbPromise: Promise<IDBDatabase> | null = null;

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (!supportsIndexedDb()) {
    return Promise.reject(new Error("Local world storage is unavailable."));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PART_STORE)) {
        db.createObjectStore(PART_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(WORLD_STORE)) {
        db.createObjectStore(WORLD_STORE, { keyPath: "worldId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

const indexedDbStorage: LocalWorldStorage = {
  async putPart(record) {
    const db = await openDb();
    const tx = db.transaction(PART_STORE, "readwrite");
    tx.objectStore(PART_STORE).put(record);
    await waitForTransaction(tx);
  },
  async finishWorld(record) {
    const db = await openDb();
    const tx = db.transaction(WORLD_STORE, "readwrite");
    tx.objectStore(WORLD_STORE).put(record);
    await waitForTransaction(tx);
  },
  async cleanupWorld(ownership) {
    await deleteLocalVoxelWorldParts(ownership.partKeys, ownership.worldId);
  },
  async prune(keepWorldId) {
    const db = await openDb();
    const tx = db.transaction([PART_STORE, WORLD_STORE], "readwrite");
    const partStore = tx.objectStore(PART_STORE);
    const worldStore = tx.objectStore(WORLD_STORE);
    const worlds = ((await promisifyRequest(worldStore.getAll())) as LocalWorldMetaRecord[])
      .sort((a, b) => a.touchedAt - b.touchedAt);
    let totalBytes = worlds.reduce((sum, world) => sum + Math.max(0, world.byteSize), 0);
    let count = worlds.length;

    for (const world of worlds) {
      if (world.worldId === keepWorldId) continue;
      if (count <= MAX_LOCAL_WORLD_COUNT && totalBytes <= MAX_LOCAL_WORLD_BYTES) break;
      for (const key of world.partKeys) partStore.delete(key);
      worldStore.delete(world.worldId);
      totalBytes -= Math.max(0, world.byteSize);
      count -= 1;
    }
    await waitForTransaction(tx);
  },
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function makeWorldId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local-${random}`;
}

function bytesForJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isBlobLikeInput(input: unknown): input is BlobLikeInput {
  if (!input || typeof input !== "object") return false;
  return typeof (input as { stream?: unknown }).stream === "function";
}

async function prepareLocalVoxelWorldInput(
  input: unknown,
  opts: {
    signal?: AbortSignal;
    onProgress?: (progress: LocalVoxelWorldProgress) => void;
  },
): Promise<PreparedLocalVoxelWorldInput> {
  if (!isBlobLikeInput(input)) {
    const parsed = parseVoxelBuildSpec(input);
    if (!parsed.ok) throw new Error(parsed.error);
    const sourceBytes = bytesForJson(parsed.value);
    return {
      sourceBuild: parsed.value,
      sourceSha: await sha256Hex(sourceBytes),
      buildForReturn: parsed.value,
      bytesRead: sourceBytes.byteLength,
      totalBytes: sourceBytes.byteLength,
    };
  }

  const { createHash } = await import("crypto");
  const hash = createHash("sha256");
  const totalBytes = Number.isFinite(input.size) && input.size !== undefined && input.size >= 0
    ? input.size
    : undefined;
  let bytesRead = 0;

  const chunks = (async function* () {
    const reader = input.stream().getReader();
    let completed = false;
    const cancelReader = () => {
      void reader.cancel().catch(() => undefined);
    };

    opts.signal?.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        throwIfAborted(opts.signal);
        const result = await reader.read();
        throwIfAborted(opts.signal);
        if (result.done) {
          completed = true;
          break;
        }
        hash.update(result.value);
        bytesRead += result.value.byteLength;
        opts.onProgress?.({
          stage: "reading",
          bytesRead,
          ...(totalBytes === undefined ? {} : { totalBytes }),
        });
        yield result.value;
      }
    } finally {
      opts.signal?.removeEventListener("abort", cancelReader);
      if (!completed) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
  })();

  const sourceBuild = await parseVoxelBuildStream(chunks);
  return {
    sourceBuild,
    sourceSha: hash.digest("hex"),
    buildForReturn: { version: "1.0", blocks: [] },
    bytesRead,
    ...(totalBytes === undefined ? {} : { totalBytes }),
  };
}

function clonePoint(point: VoxelPoint): VoxelPoint {
  return { x: point.x, y: point.y, z: point.z };
}

function regionBounds(region: Pick<EvaluatedVoxelWorldRegion, "origin" | "size">): VoxelWorldBounds {
  return { origin: clonePoint(region.origin), size: clonePoint(region.size) };
}

function includeBounds(bounds: VoxelWorldBounds | null, next: VoxelWorldBounds): VoxelWorldBounds {
  if (!bounds) return { origin: clonePoint(next.origin), size: clonePoint(next.size) };
  const origin = {
    x: Math.min(bounds.origin.x, next.origin.x),
    y: Math.min(bounds.origin.y, next.origin.y),
    z: Math.min(bounds.origin.z, next.origin.z),
  };
  const end = {
    x: Math.max(bounds.origin.x + bounds.size.x, next.origin.x + next.size.x),
    y: Math.max(bounds.origin.y + bounds.size.y, next.origin.y + next.size.y),
    z: Math.max(bounds.origin.z + bounds.size.z, next.origin.z + next.size.z),
  };
  return {
    origin,
    size: { x: end.x - origin.x, y: end.y - origin.y, z: end.z - origin.z },
  };
}

function encodeMixedRegion(region: MixedVoxelWorldRegion, palette: ReturnType<typeof getPalette>, sourceSha: string): Uint8Array {
  const packed = createPackedVoxelBlocks(region.blockCount);
  const typeIdByName = new Map<string, number>();
  const strideZ = region.size.x * region.size.y;
  let write = 0;

  for (let z = 0; z < region.size.z; z += 1) {
    for (let y = 0; y < region.size.y; y += 1) {
      for (let x = 0; x < region.size.x; x += 1) {
        const material = region.materialIndexes[x + y * region.size.x + z * strideZ]!;
        if (material === 0) continue;
        const type = palette[material - 1]?.id;
        if (!type) throw new Error("Mixed region referenced an unknown palette entry");
        let typeId = typeIdByName.get(type);
        if (typeId === undefined) {
          typeId = packed.typeNames.length;
          packed.typeNames.push(type);
          typeIdByName.set(type, typeId);
        }
        packed.positions[write * 3] = x;
        packed.positions[write * 3 + 1] = y;
        packed.positions[write * 3 + 2] = z;
        packed.typeIds[write] = typeId;
        write += 1;
      }
    }
  }

  if (write !== region.blockCount) {
    throw new Error("Mixed region block count changed during encoding");
  }
  packed.count = write;
  return encodeBinaryVoxelBuild(packed, sourceSha);
}

function localPartRef(key: string, byteSize: number): VoxelWorldPartRef {
  return { kind: "localBlob", key, encoding: "identity", byteSize };
}

async function createLocalVoxelWorldWithStorage(
  input: unknown,
  opts: {
    gridSize: number;
    palette: Palette;
    signal?: AbortSignal;
    worldId?: string;
    onProgress?: (progress: LocalVoxelWorldProgress) => void;
  },
  storage: LocalWorldStorage,
): Promise<LocalVoxelWorldResult> {
  throwIfAborted(opts.signal);
  const prepared = await prepareLocalVoxelWorldInput(input, opts);
  throwIfAborted(opts.signal);
  opts.onProgress?.({
    stage: "building",
    ...(prepared.bytesRead === undefined ? {} : { bytesRead: prepared.bytesRead }),
    ...(prepared.totalBytes === undefined ? {} : { totalBytes: prepared.totalBytes }),
  });

  const palette = getPalette(opts.palette);
  const evaluated = evaluateVoxelWorldRegions(prepared.sourceBuild, {
    gridSize: opts.gridSize,
    palette,
    mixedLeafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
  });
  if (!evaluated.ok) throw new Error(evaluated.error);

  const sourceSha = prepared.sourceSha;
  const paletteIds = palette.map((block) => block.id);
  const materialByType = new Map(paletteIds.map((type, index) => [type, index + 1]));
  const overview = createVoxelWorldOverviewState(opts.gridSize, palette.length);
  const worldId = opts.worldId?.trim() || makeWorldId();
  const partKeys: string[] = [];
  let totalPartBytes = 0;

  const putBytes = async (key: string, bytes: Uint8Array) => {
    throwIfAborted(opts.signal);
    await storage.putPart({
      key,
      worldId,
      bytes,
      byteSize: bytes.byteLength,
      touchedAt: Date.now(),
    });
    partKeys.push(key);
    totalPartBytes += bytes.byteLength;
    throwIfAborted(opts.signal);
  };

  try {
    const regions: VoxelWorldRegion[] = [];
    let blockCount = 0;
    let bounds: VoxelWorldBounds | null = null;
    let regionIndex = 0;

    for (const region of evaluated.regions) {
      throwIfAborted(opts.signal);
      const key = `${worldId}.region.${regionIndex}`;
      blockCount += region.blockCount;
      bounds = includeBounds(bounds, regionBounds(region));

      if (region.kind === "uniform") {
        const material = materialByType.get(region.type);
        if (overview && material) markUniformVoxelWorldOverviewRegion(overview, region, material);
        regions.push({
          kind: "uniform",
          key,
          origin: clonePoint(region.origin),
          size: clonePoint(region.size),
          type: region.type,
          blockCount: region.blockCount,
        });
      } else {
        if (overview) markMixedVoxelWorldOverviewRegion(overview, region);
        const dataKey = `${worldId}.part.${regionIndex}.mbv4`;
        const bytes = encodeMixedRegion(region, palette, sourceSha);
        await putBytes(dataKey, bytes);
        regions.push({
          kind: "mixed",
          key,
          origin: clonePoint(region.origin),
          size: clonePoint(region.size),
          blockCount: region.blockCount,
          format: "mbv4",
          coordinateSpace: "local",
          data: localPartRef(dataKey, bytes.byteLength),
        });
      }

      regionIndex += 1;
    }

    let overviewData: VoxelWorldPartRef | undefined;
    if (overview && blockCount > 0) {
      const overviewBuild = encodeVoxelWorldOverviewBuild(overview, paletteIds, sourceSha);
      const overviewKey = `${worldId}.overview.mbv4`;
      await putBytes(overviewKey, overviewBuild.bytes);
      overviewData = localPartRef(overviewKey, overviewBuild.bytes.byteLength);
    }

    const manifestBase: Omit<VoxelWorldManifest, "regions" | "regionPages"> = {
      kind: "voxel_world" as const,
      version: VOXEL_WORLD_MANIFEST_VERSION as typeof VOXEL_WORLD_MANIFEST_VERSION,
      gridSize: opts.gridSize,
      palette: opts.palette,
      bounds,
      exactBlockCount: blockCount,
      leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE as typeof VOXEL_WORLD_MIXED_LEAF_SIZE,
      source: {
        format: "voxel-build-json" as const,
        sha256: sourceSha,
        evaluatorVersion: VOXEL_WORLD_EVALUATOR_VERSION,
      },
      ...(overviewData ? { overview: { data: overviewData, scale: VOXEL_WORLD_OVERVIEW_SCALE } } : {}),
    };
    let manifest: VoxelWorldManifest;

    if (regions.length <= VOXEL_WORLD_INLINE_REGION_LIMIT) {
      manifest = regions.length > 0 ? { ...manifestBase, regions } : manifestBase;
    } else {
      const regionPages: VoxelWorldRegionPageRef[] = [];
      for (let index = 0; index < regions.length; index += VOXEL_WORLD_REGION_PAGE_LIMIT) {
        const pageRegions = regions.slice(index, index + VOXEL_WORLD_REGION_PAGE_LIMIT);
        const pageIndex = regionPages.length;
        const pageBounds = pageRegions.reduce<VoxelWorldBounds | null>(
          (current, region) => includeBounds(current, regionBounds(region)),
          null,
        );
        if (!pageBounds) continue;
        const pageBlockCount = pageRegions.reduce((sum, region) => sum + region.blockCount, 0);
        const page: VoxelWorldRegionPage = {
          kind: "voxel_world_region_page",
          version: VOXEL_WORLD_MANIFEST_VERSION,
          index: pageIndex,
          bounds: pageBounds,
          regionCount: pageRegions.length,
          blockCount: pageBlockCount,
          regions: pageRegions,
        };
        const parsedPage = parseVoxelWorldRegionPage(page, {
          gridSize: opts.gridSize,
          worldBounds: bounds,
          allowLocalBlobRefs: true,
        });
        if (!parsedPage.ok) throw new Error(parsedPage.error);
        const pageKey = `${worldId}.page.${pageIndex}.json`;
        const pageBytes = bytesForJson(page);
        await putBytes(pageKey, pageBytes);
        regionPages.push({
          index: pageIndex,
          bounds: pageBounds,
          regionCount: pageRegions.length,
          blockCount: pageBlockCount,
          data: localPartRef(pageKey, pageBytes.byteLength),
        });
      }
      manifest = { ...manifestBase, regionPages };
    }

    const parsedManifest = parseVoxelWorldManifest(manifest, { allowLocalBlobRefs: true });
    if (!parsedManifest.ok) throw new Error(parsedManifest.error);

    await storage.finishWorld({
      worldId,
      partKeys,
      byteSize: totalPartBytes,
      touchedAt: Date.now(),
    });
    await storage.prune(worldId);
    throwIfAborted(opts.signal);

    return {
      worldId,
      partKeys,
      build: {
        ...prepared.buildForReturn,
        world: { manifest: parsedManifest.value },
      },
      warnings: evaluated.warnings,
      blockCount,
    };
  } catch (error) {
    await storage.cleanupWorld({ worldId, partKeys }).catch(() => {});
    throw error;
  }
}

export async function createLocalVoxelWorld(
  input: unknown,
  opts: {
    gridSize: number;
    palette: Palette;
    signal?: AbortSignal;
    worldId?: string;
    onProgress?: (progress: LocalVoxelWorldProgress) => void;
  },
): Promise<LocalVoxelWorldResult> {
  return createLocalVoxelWorldWithStorage(input, opts, indexedDbStorage);
}

export function attachLocalVoxelWorldResolver(build: RenderableVoxelBuild): RenderableVoxelBuild {
  if (!build.world || build.world.partBaseUrl) return build;
  return {
    ...build,
    world: {
      ...build.world,
      resolvePart: readLocalVoxelWorldPart,
    },
  };
}

export async function readLocalVoxelWorldPart(key: string, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const db = await openDb();
  const tx = db.transaction([PART_STORE, WORLD_STORE], "readwrite");
  const partStore = tx.objectStore(PART_STORE);
  const worldStore = tx.objectStore(WORLD_STORE);
  const record = (await promisifyRequest(partStore.get(key))) as LocalWorldPartRecord | undefined;
  if (!record?.bytes) throw new Error("Local world part is missing.");
  const world = (await promisifyRequest(worldStore.get(record.worldId))) as LocalWorldMetaRecord | undefined;
  if (world) {
    worldStore.put({ ...world, touchedAt: Date.now() } satisfies LocalWorldMetaRecord);
  }
  await waitForTransaction(tx);
  throwIfAborted(signal);
  return record.bytes;
}

export async function deleteLocalVoxelWorldParts(
  partKeys: readonly string[],
  worldId?: string,
): Promise<void> {
  if (!supportsIndexedDb() || (partKeys.length === 0 && !worldId)) return;
  const db = await openDb();
  const tx = db.transaction([PART_STORE, WORLD_STORE], "readwrite");
  const partStore = tx.objectStore(PART_STORE);
  const worldStore = tx.objectStore(WORLD_STORE);
  let keys = Array.from(partKeys);
  if (keys.length === 0 && worldId) {
    const world = (await promisifyRequest(worldStore.get(worldId))) as LocalWorldMetaRecord | undefined;
    keys = world?.partKeys ?? [];
  }
  for (const key of keys) partStore.delete(key);
  if (worldId) worldStore.delete(worldId);
  await waitForTransaction(tx);
}

export async function createLocalVoxelWorldForTest(
  input: unknown,
  opts: {
    gridSize: number;
    palette: Palette;
    worldId?: string;
    signal?: AbortSignal;
    onProgress?: (progress: LocalVoxelWorldProgress) => void;
    parts?: Map<string, Uint8Array>;
    onPutPart?: (record: LocalWorldPartRecord) => void | Promise<void>;
  },
): Promise<LocalVoxelWorldResult & { parts: Map<string, Uint8Array> }> {
  const parts = opts.parts ?? new Map<string, Uint8Array>();
  const storage: LocalWorldStorage = {
    async putPart(record) {
      parts.set(record.key, record.bytes);
      await opts.onPutPart?.(record);
    },
    async finishWorld() {},
    async cleanupWorld(ownership) {
      for (const key of ownership.partKeys) parts.delete(key);
    },
    async prune() {},
  };
  const result = await createLocalVoxelWorldWithStorage(input, opts, storage);
  return { ...result, parts };
}
