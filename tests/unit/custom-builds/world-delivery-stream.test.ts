import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

async function withStorageEnv(run: () => Promise<void>): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = "http://127.0.0.1:43219";
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

async function expectSettled<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = Symbol(label);
  const result = await Promise.race([promise, delay(500).then(() => timeout)]);
  assert.notEqual(result, timeout, label);
  return result as T;
}

async function checkLargePartIsReturnedAsAStream() {
  const { customBuildWorldViewerResponse } = await import("../../../lib/custom-builds/worldDelivery");
  const bytes = largeGzipLikePart();
  const fetchStarted = deferred<void>();
  let releaseBody: (() => void) | undefined;

  await withStorageEnv(async () => {
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "http://127.0.0.1:43219/storage/v1/object/unit/held-large-part");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer world-delivery-stream-test-secret");
      fetchStarted.resolve();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 4));
          releaseBody = () => {
            controller.enqueue(bytes.subarray(4));
            controller.close();
          };
        },
      }));
    }) as typeof fetch;

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
    await expectSettled(fetchStarted.promise, "stream body read should start the storage fetch");
    assert.ok(releaseBody, "storage response should expose a held body");
    releaseBody();
    const delivered = new Uint8Array(await bodyPromise);
    assert.equal(delivered.byteLength, bytes.byteLength);
    assert.equal(sha256(delivered), sha256(bytes), "streamed world part bytes should be preserved");
  });
}

async function checkCancelClosesUpstream() {
  const { customBuildWorldViewerResponse } = await import("../../../lib/custom-builds/worldDelivery");
  const firstChunk = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0x42);
  const upstreamCanceled = deferred<void>();

  await withStorageEnv(async () => {
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal, "storage stream should receive the request abort signal");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk);
          signal.addEventListener("abort", () => {
            upstreamCanceled.resolve();
            controller.error(signal.reason ?? new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
        cancel() {
          upstreamCanceled.resolve();
        },
      }));
    }) as typeof fetch;

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
    assert.deepEqual(first.value, firstChunk);
    const pendingRead = reader.read().catch(() => null);
    await delay(0);
    await reader.cancel();
    await expectSettled(upstreamCanceled.promise, "canceling the response body should cancel storage streaming");
    await pendingRead;
  });
}

checkLargePartIsReturnedAsAStream()
  .then(checkCancelClosesUpstream)
  .then(() => {
    console.log("world delivery streaming checks passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
