"use client";

import type { VoxelMeshPayload } from "@/lib/voxel/mesh";

type MeshPayloadRecord = {
  key: string;
  payload: VoxelMeshPayload;
};

type MeshPayloadMeta = {
  key: string;
  byteWeight: number;
  touchedAt: number;
};

const DB_NAME = "minebench-voxel-mesh-cache";
const DB_VERSION = 1;
const PAYLOAD_STORE = "payloads";
const META_STORE = "meta";
const CACHE_VERSION = "v1";
const MAX_ENTRIES = 6;
const MAX_TOTAL_BYTES = 160_000_000;
const MAX_ENTRY_BYTES = 80_000_000;

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
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) {
        db.createObjectStore(PAYLOAD_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });

  return dbPromise;
}

function estimateSerializedBucketBytes(
  bucket: VoxelMeshPayload["opaque"] | VoxelMeshPayload["cutout"] | VoxelMeshPayload["transparent"] | VoxelMeshPayload["water"] | VoxelMeshPayload["emissive"],
): number {
  if (!bucket) return 0;
  return (
    bucket.positions.byteLength +
    bucket.normals.byteLength +
    bucket.uvs.byteLength +
    bucket.colors.byteLength +
    bucket.indices.byteLength
  );
}

function estimatePayloadBytes(payload: VoxelMeshPayload): number {
  return (
    estimateSerializedBucketBytes(payload.opaque) +
    estimateSerializedBucketBytes(payload.cutout) +
    estimateSerializedBucketBytes(payload.transparent) +
    estimateSerializedBucketBytes(payload.water) +
    estimateSerializedBucketBytes(payload.emissive)
  );
}

async function prune(db: IDBDatabase): Promise<void> {
  const tx = db.transaction([PAYLOAD_STORE, META_STORE], "readwrite");
  const metaStore = tx.objectStore(META_STORE);
  const payloadStore = tx.objectStore(PAYLOAD_STORE);
  const entries = (await promisifyRequest(metaStore.getAll())) as MeshPayloadMeta[];
  let totalBytes = entries.reduce((sum, entry) => sum + Math.max(0, entry.byteWeight), 0);
  if (entries.length <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) {
    await waitForTransaction(tx);
    return;
  }

  const ordered = entries.sort((a, b) => a.touchedAt - b.touchedAt);
  let remainingEntries = ordered.length;
  for (const entry of ordered) {
    if (remainingEntries <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break;
    payloadStore.delete(entry.key);
    metaStore.delete(entry.key);
    totalBytes -= Math.max(0, entry.byteWeight);
    remainingEntries -= 1;
  }

  await waitForTransaction(tx);
}

export function buildPersistentMeshCacheKey(rawKey: string): string {
  return `${CACHE_VERSION}:${rawKey}`;
}

export async function getCachedMeshPayload(rawKey: string | null | undefined): Promise<VoxelMeshPayload | null> {
  const trimmed = rawKey?.trim();
  if (!trimmed || !supportsIndexedDb()) return null;

  try {
    const db = await openDb();
    const key = buildPersistentMeshCacheKey(trimmed);
    const tx = db.transaction([PAYLOAD_STORE, META_STORE], "readwrite");
    const payloadStore = tx.objectStore(PAYLOAD_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const record = (await promisifyRequest(payloadStore.get(key))) as MeshPayloadRecord | undefined;
    if (!record?.payload) {
      await waitForTransaction(tx);
      return null;
    }

    const meta = (await promisifyRequest(metaStore.get(key))) as MeshPayloadMeta | undefined;
    metaStore.put({
      key,
      byteWeight: meta?.byteWeight ?? estimatePayloadBytes(record.payload),
      touchedAt: Date.now(),
    } satisfies MeshPayloadMeta);
    await waitForTransaction(tx);
    return record.payload;
  } catch (err) {
    console.warn("mesh payload cache read failed", err);
    return null;
  }
}

export async function setCachedMeshPayload(
  rawKey: string | null | undefined,
  payload: VoxelMeshPayload,
): Promise<void> {
  const trimmed = rawKey?.trim();
  if (!trimmed || !supportsIndexedDb()) return;

  const byteWeight = estimatePayloadBytes(payload);
  if (!Number.isFinite(byteWeight) || byteWeight <= 0 || byteWeight > MAX_ENTRY_BYTES) {
    return;
  }

  try {
    const db = await openDb();
    const key = buildPersistentMeshCacheKey(trimmed);
    const tx = db.transaction([PAYLOAD_STORE, META_STORE], "readwrite");
    tx.objectStore(PAYLOAD_STORE).put({ key, payload } satisfies MeshPayloadRecord);
    tx.objectStore(META_STORE).put({
      key,
      byteWeight,
      touchedAt: Date.now(),
    } satisfies MeshPayloadMeta);
    await waitForTransaction(tx);
    await prune(db);
  } catch (err) {
    console.warn("mesh payload cache write failed", err);
  }
}
