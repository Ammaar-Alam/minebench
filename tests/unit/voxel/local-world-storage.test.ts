import assert from "node:assert/strict";
import {
  attachLocalVoxelWorldResolver,
  createLocalVoxelWorld,
  createLocalVoxelWorldForTest,
  readLocalVoxelWorldPart,
} from "../../../lib/voxel/localWorld";

type RecordValue = { worldId: string; touchedAt: number; byteSize: number; key?: string; bytes?: Uint8Array; partKeys?: string[] };
type StoreName = "parts" | "worlds";
type TransactionLog = { stores: string[]; mode: IDBTransactionMode; reads: string[]; writes: string[] };

async function main() {
  const source = new Blob(['{"version":"1.0","blocks":[{"x":0,"y":0,"z":0,"type":"stone"},{"x":1,"y":0,"z":0,"type":"glass"}]}']);
  const fixture = await createLocalVoxelWorldForTest(source, { gridSize: 2048, palette: "simple", worldId: "world-a" });
  const records: Record<StoreName, Map<string, RecordValue>> = { parts: new Map(), worlds: new Map() };
  for (const [key, bytes] of fixture.parts) records.parts.set(key, { key, bytes, worldId: fixture.worldId, byteSize: bytes.byteLength, touchedAt: 1 });
  records.worlds.set(fixture.worldId, { worldId: fixture.worldId, partKeys: fixture.partKeys, byteSize: 1000, touchedAt: 1 });
  for (const [index, suffix] of ["b", "c", "d", "e", "f", "g"].entries()) {
    const worldId = `world-${suffix}`;
    records.parts.set(worldId, { key: worldId, bytes: new Uint8Array([index]), worldId, byteSize: 1, touchedAt: index + 2 });
    records.worlds.set(worldId, { worldId, partKeys: [worldId], byteSize: 1, touchedAt: index + 2 });
  }

  const transactions: TransactionLog[] = [];
  let beforeRead: ((store: StoreName) => void) | undefined;
  let failOwnerWrite = false;
  const ownerError = new Error("owner write failed");
  const database = {
    transaction(names: string | string[], mode: IDBTransactionMode) {
      const log = { stores: typeof names === "string" ? [names] : names, mode, reads: [] as string[], writes: [] as string[] };
      transactions.push(log);
      let pending = 0;
      let finished = false;
      const tx = { oncomplete: null, onabort: null, onerror: null, error: null } as unknown as IDBTransaction;
      const request = <T>(action: () => T) => {
        const req = { result: undefined as T, onsuccess: null, onerror: null } as unknown as IDBRequest<T>;
        pending += 1;
        setImmediate(() => {
          try {
            Object.assign(req, { result: action() });
            req.onsuccess?.call(req, {} as Event);
          } catch (error) {
            finished = true;
            Object.assign(tx, { error });
            tx.onabort?.call(tx, {} as Event);
          } finally {
            pending -= 1;
            setImmediate(() => {
              if (pending || finished) return;
              finished = true;
              tx.oncomplete?.call(tx, {} as Event);
            });
          }
        });
        return req;
      };
      tx.objectStore = (name: string) => {
        assert.ok(log.stores.includes(name), "transactions must include every accessed store");
        const store = name as StoreName;
        return {
          get(key: string) {
            log.reads.push(`${store}:${key}`);
            return request(() => { beforeRead?.(store); return structuredClone(records[store].get(key)); });
          },
          getAll() { log.reads.push(`${store}:all`); return request(() => structuredClone([...records[store].values()])); },
          put(value: RecordValue) {
            assert.equal(mode, "readwrite");
            return request(() => {
              if (store === "worlds" && failOwnerWrite) throw ownerError;
              const key = store === "parts" ? value.key! : value.worldId;
              records[store].set(key, structuredClone(value));
              log.writes.push(`${store}:${key}`);
            });
          },
          delete(key: string) {
            assert.equal(mode, "readwrite");
            return request(() => { records[store].delete(key); log.writes.push(`delete:${store}:${key}`); });
          },
        } as unknown as IDBObjectStore;
      };
      return tx;
    },
  };
  const previousIndexedDb = globalThis.indexedDB;
  const previousNow = Date.now;
  let now = 10;
  Date.now = () => now;
  globalThis.indexedDB = {
    open() {
      const req = { result: database, onsuccess: null } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => req.onsuccess?.call(req, {} as Event));
      return req;
    },
  } as unknown as IDBFactory;

  try {
    const key = fixture.partKeys[0]!;
    const ownerTime = () => records.worlds.get(fixture.worldId)!.touchedAt;
    const ownerWrites = () => transactions.reduce((count, tx) => count + tx.writes.filter((write) => write === `worlds:${fixture.worldId}`).length, 0);
    await readLocalVoxelWorldPart(key);
    assert.equal(ownerTime(), 10, "direct unscoped reads retain their access-time update");
    const directStart = transactions.length;
    await readLocalVoxelWorldPart(key, undefined, { touchOwner: false });
    assert.ok(transactions.slice(directStart).every((tx) => tx.mode === "readonly" && tx.stores.join() === "parts"));

    const resolvePart = attachLocalVoxelWorldResolver(fixture.build).world!.resolvePart!;
    const controller = new AbortController();
    now = 20;
    const writesBefore = ownerWrites();
    await Promise.all(Array.from({ length: 4 }, (_, index) => resolvePart(fixture.partKeys[index % fixture.partKeys.length]!, controller.signal)));
    assert.equal(ownerWrites(), writesBefore + 1, "concurrent reads touch one owner once per load");
    now = 21;
    await resolvePart(key, controller.signal);
    assert.equal(ownerTime(), 20);
    now = 30;
    await resolvePart(key, new AbortController().signal);
    assert.equal(ownerTime(), 30, "reopening with the same resolver must refresh its owner");

    const missing = new AbortController();
    await assert.rejects(resolvePart("missing", missing.signal), /Local world part is missing/);
    assert.equal(ownerTime(), 30);
    now = 40;
    await resolvePart(key, missing.signal);
    assert.equal(ownerTime(), 40, "a missing first part must not suppress a later touch");

    for (const store of ["parts", "worlds"] as const) {
      const canceled = new AbortController();
      beforeRead = (name) => { if (name === store) canceled.abort(); };
      await assert.rejects(resolvePart(key, canceled.signal), (error) => error instanceof DOMException && error.name === "AbortError");
      beforeRead = undefined;
      assert.equal(ownerTime(), 40, "canceled reads must not update eviction metadata");
    }
    const failed = new AbortController();
    failOwnerWrite = true;
    await assert.rejects(resolvePart(key, failed.signal), (error) => error === ownerError);
    failOwnerWrite = false;
    now = 50;
    await resolvePart(key, failed.signal);
    assert.equal(ownerTime(), 50, "failed owner updates must remain retryable");

    const producerStart = transactions.length;
    now = 60;
    await createLocalVoxelWorld(source, { gridSize: 2048, palette: "simple", worldId: "world-h" });
    const producer = transactions.slice(producerStart);
    assert.ok(producer.some((tx) => tx.mode === "readonly" && tx.stores.join() === "parts"));
    assert.ok(producer.every((tx) => !tx.reads.includes("worlds:world-h")), "preparation must not fetch unfinished owner metadata per part");
    assert.ok(transactions.filter((tx) => tx.reads.some((read) => read.startsWith("parts:"))).every((tx) => tx.mode === "readonly" && tx.stores.join() === "parts"));
    assert.equal(records.worlds.size, 6);
    assert.ok(records.worlds.has("world-a"), "the recently opened world must survive oldest-first eviction");
    assert.ok(!records.worlds.has("world-b") && !records.worlds.has("world-c"));
    assert.ok(!records.parts.has("world-b") && !records.parts.has("world-c"));
    console.log("local world storage transaction checks passed");
  } finally {
    globalThis.indexedDB = previousIndexedDb;
    Date.now = previousNow;
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
