import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

const SOURCE_SHA = "a".repeat(64);
const PART_SHA = "b".repeat(64);

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifact(path: string, sha = PART_SHA) {
  return {
    bucket: "unit",
    path,
    contentType: "application/gzip",
    encoding: "gzip",
    sha256: sha,
    sourceBuildSha256: SOURCE_SHA,
  };
}

function largeGzipLikePart(): Uint8Array {
  const bytes = new Uint8Array(5 * 1024 * 1024 + 17);
  bytes[0] = 0x1f;
  bytes[1] = 0x8b;
  bytes[2] = 0x08;
  bytes[3] = 0x00;
  for (let index = 4; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

async function withStorageEnv(run: () => Promise<void>, url = "http://127.0.0.1:43219"): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = url;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_SECRET_KEY = "world-delivery-stream-test-secret";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// storage serves objects uploaded with Content-Encoding back with that header, which fetch would decode
async function withStorageServer(handler: RequestListener, run: () => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await withStorageEnv(run, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function expectSettled<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = Symbol(label);
  const result = await Promise.race([promise, delay(500).then(() => timeout)]);
  assert.notEqual(result, timeout, label);
  return result as T;
}

async function checkLargePartIsReturnedAsAStream() {
  const { customBuildWorldViewerResponse } = await import("../../../lib/custom-builds/worldDelivery");
  const bytes = largeGzipLikePart();
  const requestStarted = deferred<void>();
  const bodyReleased = deferred<void>();

  await withStorageServer(async (req, res) => {
    assert.equal(req.url, "/storage/v1/object/unit/held-large-part");
    assert.equal(req.headers.authorization, "Bearer world-delivery-stream-test-secret");
    assert.equal(req.headers["accept-encoding"], "gzip");
    requestStarted.resolve();
    res.writeHead(200, { "Content-Type": "application/gzip", "Content-Encoding": "gzip" });
    res.write(bytes.subarray(0, 4));
    await bodyReleased.promise;
    res.end(bytes.subarray(4));
  }, async () => {
    const responsePromise = customBuildWorldViewerResponse({
      request: new Request("http://localhost:3000/api/generations/cb/artifacts/viewer?part=held-large-part"),
      artifact: artifact("manifest"),
      buildId: "cb",
      findPart: async () => artifact("held-large-part"),
      cacheControl: "private, no-store",
    });
    const pending = Symbol("pending");
    const response = await Promise.race([responsePromise, delay(50).then(() => pending)]);
    assert.notEqual(response, pending, "world part response should not wait for the storage body to finish");
    assert.equal((response as Response).headers.get("content-type"), "application/gzip");
    assert.equal((response as Response).headers.get("content-encoding"), null);

    const bodyPromise = (response as Response).arrayBuffer();
    await expectSettled(requestStarted.promise, "stream body read should start the storage request");
    bodyReleased.resolve();
    const delivered = new Uint8Array(await bodyPromise);
    assert.equal(delivered.byteLength, bytes.byteLength);
    assert.equal(sha256(delivered), sha256(bytes), "stored world part bytes should be delivered without decoding");

    const pinned = (v: string) => customBuildWorldViewerResponse({
      request: new Request(`http://localhost:3000/api/gallery/examples/cb/viewer?format=world&part=held-large-part&v=${v}`),
      artifact: artifact("manifest"),
      buildId: "cb",
      findPart: async () => artifact("held-large-part"),
      cacheControl: "public, max-age=300",
    });
    const cached = await pinned(PART_SHA.toUpperCase());
    assert.equal(cached.headers.get("cache-control"), "public, max-age=31536000, s-maxage=3600, immutable");
    await cached.body?.cancel();
    assert.equal((await pinned("0".repeat(64))).status, 404);
  });
}

async function checkCancelClosesUpstream() {
  const { customBuildWorldViewerResponse } = await import("../../../lib/custom-builds/worldDelivery");
  const firstChunk = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x42);
  const upstreamCanceled = deferred<void>();

  await withStorageServer((_req, res) => {
    res.on("close", () => upstreamCanceled.resolve());
    res.writeHead(200, { "Content-Type": "application/gzip", "Content-Encoding": "gzip" });
    res.write(firstChunk);
  }, async () => {
    const response = await customBuildWorldViewerResponse({
      request: new Request("http://localhost:3000/api/generations/cb/artifacts/viewer?part=cancel-part"),
      artifact: artifact("manifest"),
      buildId: "cb",
      findPart: async () => artifact("cancel-part"),
      cacheControl: "private, no-store",
    });
    assert.ok(response.body, "streamed world part response should have a body");
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.deepEqual(new Uint8Array(first.value!), firstChunk);
    const pendingRead = reader.read().catch(() => null);
    await delay(0);
    await reader.cancel();
    await expectSettled(upstreamCanceled.promise, "canceling the response body should cancel storage streaming");
    await pendingRead;
  });
}

async function checkPageIdentity() {
  const { customBuildWorldViewerResponse } = await import("../../../lib/custom-builds/worldDelivery");
  const bounds = { origin: { x: 0, y: 0, z: 0 }, size: { x: 64, y: 64, z: 64 } };
  const page = {
    kind: "voxel_world_region_page", version: 1, index: 0, bounds, regionCount: 1, blockCount: 1,
    regions: [{ kind: "mixed", key: "mixed-0", ...bounds, blockCount: 1, format: "mbv4", coordinateSpace: "local",
      data: { kind: "stored", key: "mixed-0", bucket: "unit", path: "private/region", encoding: "gzip", byteSize: 40, sha256: PART_SHA } }],
  };
  const pageBytes = gzipSync(JSON.stringify(page));
  const manifest = {
    kind: "voxel_world", version: 1, gridSize: 8192, palette: "simple", bounds, exactBlockCount: 1, leafSize: 64,
    source: { format: "build_json", sha256: SOURCE_SHA, evaluatorVersion: 1 },
    regionPages: [{ index: 0, bounds, regionCount: 1, blockCount: 1,
      data: { kind: "stored", key: "page-0", bucket: "unit", path: "page", encoding: "gzip", byteSize: pageBytes.length, sha256: sha256(pageBytes) } }],
  };
  const { parseVoxelWorldRegionPage, toOpaqueVoxelWorldRegionPage } = await import("../../../lib/voxel/world");
  const parsed = parseVoxelWorldRegionPage(page, { allowStoredRefs: true });
  assert.ok(parsed.ok);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(toOpaqueVoxelWorldRegionPage(parsed.value)));
  for (const [precomputed, decoded] of [[false, false], [true, false], [false, true], [true, true]]) {
    const storedManifest = { ...manifest, regionPages: manifest.regionPages.map((ref) => ({
      ...ref, ...(precomputed ? { delivery: { byteSize: expectedBytes.length, sha256: sha256(expectedBytes) } } : {}),
    })) };
    let manifestBytes = gzipSync(JSON.stringify(storedManifest));
    await withStorageEnv(async () => {
      let pageReads = 0;
      globalThis.fetch = async (input) => {
        if (String(input).endsWith("/manifest")) return new Response(manifestBytes);
        pageReads += 1;
        return new Response(decoded ? JSON.stringify(page) : pageBytes);
      };
      const get = (part = "") => customBuildWorldViewerResponse({
        request: new Request(`http://localhost/api/generations/cb/artifacts/viewer${part ? `?part=${part}` : ""}`),
        artifact: artifact("manifest", sha256(manifestBytes)), buildId: "cb", cacheControl: "private, no-store",
        findPart: async (_source, key) => key === "page-0" ? artifact("page", sha256(pageBytes)) : null,
      });
      const delivered = await (await get()).json();
      assert.equal(pageReads, precomputed ? 0 : 1, "new manifests must not read region pages before delivery");
      assert.equal(delivered.voxelBuild.world.manifest.regionPages[0].delivery, undefined);
      const ref = delivered.voxelBuild.world.manifest.regionPages[0].data;
      const response = await get("page-0");
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes.length, ref.byteSize, "page size must describe the bytes returned to clients");
      assert.equal(sha256(bytes), ref.sha256, "page checksum must describe the bytes returned to clients");
      assert.equal(ref.encoding, "identity");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(
        (await get(`page-0&v=${ref.sha256}`)).headers.get("cache-control"),
        "private, max-age=31536000, immutable",
        "hash-pinned parts are cacheable",
      );
      assert.equal((await get(`page-0&v=${"0".repeat(64)}`)).status, 404, "stale hashes never cache other bytes");
      const text = new TextDecoder().decode(bytes);
      assert.equal(text.includes("private/region"), false);
      assert.equal(JSON.parse(text).regions[0].data.kind, "opaque");
      if (!decoded) {
        storedManifest.regionPages[0]!.data.byteSize += 1;
        manifestBytes = gzipSync(JSON.stringify(storedManifest));
        await assert.rejects(get("page-0"), /page metadata does not match/);
        storedManifest.regionPages[0]!.data.byteSize -= 1;
      }
      if (precomputed) {
        storedManifest.regionPages[0]!.delivery!.sha256 = "0".repeat(64);
        manifestBytes = gzipSync(JSON.stringify(storedManifest));
        await assert.rejects(get("page-0"), /page delivery does not match/);
      }
    });
  }
}

checkLargePartIsReturnedAsAStream()
  .then(checkCancelClosesUpstream)
  .then(checkPageIdentity)
  .then(() => {
    console.log("world delivery streaming checks passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
