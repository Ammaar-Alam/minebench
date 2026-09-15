import assert from "node:assert/strict";
import { fetchWithRetry, FetchError } from "../../lib/fetchWithRetry";
import {
  recordApiFailure,
  __getHealthForTesting,
  __resetApiHealth,
} from "../../lib/apiHealth";

const ORIGINAL_FETCH = globalThis.fetch;

type FetchStub = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function installFetch(stub: FetchStub): () => void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    stub(input, init)) as typeof fetch;
  return () => {
    globalThis.fetch = ORIGINAL_FETCH;
  };
}

const encoder = new TextEncoder();

/** A "200 OK then body stalls" response: emits one partial JSON chunk, then
 * never enqueues again. It errors the body when the fetch signal aborts,
 * faithfully mirroring what the real fetch does on an internal timeout. */
function stallingBodyResponse(signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"ok":'));
      signal.addEventListener(
        "abort",
        () => {
          controller.error(new DOMException("This operation was aborted", "AbortError"));
        },
        { once: true },
      );
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

/** A complete, well-formed JSON response that closes immediately. */
function okJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch that never resolves until its signal aborts (headers never arrive). */
function neverResolvingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new DOMException("This operation was aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("This operation was aborted", "AbortError")),
      { once: true },
    );
  });
}

function assertNotFetchError(err: unknown): void {
  assert.equal(
    err instanceof FetchError,
    false,
    `expected a raw AbortError, not a FetchError, got ${(err as Error)?.message}`,
  );
}

async function main() {
  // ---------------------------------------------------------------------
  // Facet #1 — classification: a body-stall timeout surfaces as
  // FetchError("timeout"), not a raw DOMException indistinguishable from a
  // parent cancel.
  // ---------------------------------------------------------------------
  {
    const restore = installFetch((_input, init) => stallingBodyResponse(init?.signal ?? new AbortController().signal));
    try {
      __resetApiHealth();
      const endpoint = "/api/test-body-stall-timeout";
      let caught: unknown = null;
      try {
        const res = await fetchWithRetry(endpoint, { timeoutMs: 60, retries: 0 });
        await res.json();
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "body-stall should reject res.json()");
      assert.ok(
        caught instanceof FetchError,
        `body-stall timeout must be a FetchError, got ${(caught as Error)?.name}: ${(caught as Error)?.message}`,
      );
      assert.equal((caught as FetchError).kind, "timeout");
      assert.equal((caught as FetchError).retryable, true);
      assert.equal((caught as FetchError).status, null);
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // Facet #1 — parent-signal cancel during body read still propagates the
  // raw AbortError (cancel semantics preserved, NOT reclassified).
  // ---------------------------------------------------------------------
  {
    const restore = installFetch((_input, init) => stallingBodyResponse(init?.signal ?? new AbortController().signal));
    try {
      __resetApiHealth();
      const endpoint = "/api/test-parent-abort-body";
      const parent = new AbortController();
      let caught: unknown = null;
      const resPromise = fetchWithRetry(endpoint, {
        timeoutMs: 5_000,
        retries: 0,
        parentSignal: parent.signal,
      });
      setTimeout(() => parent.abort(), 60);
      try {
        const res = await resPromise;
        await res.json();
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "parent-abort during body should reject res.json()");
      assertNotFetchError(caught);
      assert.equal((caught as DOMException).name, "AbortError");
      assert.ok(caught instanceof DOMException, "parent cancel must be a raw DOMException");
      // a parent cancel must NOT be recorded as a site failure
      assert.equal(__getHealthForTesting().failureCount, 0);
      assert.equal(__getHealthForTesting().degraded, false);
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // Facet #2 — a body-stall outage accrues failures like a headers stall:
  // two body-stalls push failureCount to the degrade threshold.
  // ---------------------------------------------------------------------
  {
    const restore = installFetch((_input, init) => stallingBodyResponse(init?.signal ?? new AbortController().signal));
    try {
      __resetApiHealth();
      const endpoint = "/api/test-body-stall-health";
      for (let i = 0; i < 2; i += 1) {
        await fetchWithRetry(endpoint, { timeoutMs: 60, retries: 0 })
          .then((r) => r.json())
          .catch(() => {});
      }
      const h = __getHealthForTesting();
      assert.equal(h.failureCount, 2, "two body-stalls must accrue two failures");
      assert.equal(h.degraded, true, "body-stall outage must raise the degraded banner");
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // Facet #2 — a single 200-then-stall mid-outage must NOT erase prior real
  // failures (the banner-hides-mid-outage regression). After two headers
  // stalls raise the banner, one body-stall must accrue a third failure
  // rather than recording a success that resets the count to 0.
  // ---------------------------------------------------------------------
  {
    let stub: FetchStub;
    let headersStalls = 0;
    stub = (_input, init) => {
      // first two calls: headers never arrive (then we abort via signal)
      if (headersStalls < 2) {
        headersStalls += 1;
        return neverResolvingFetch(_input, init);
      }
      // third call: 200 OK then body stalls
      return stallingBodyResponse(init?.signal ?? new AbortController().signal);
    };
    const restore = installFetch(stub);
    try {
      __resetApiHealth();
      const endpoint = "/api/test-mid-outage";
      // two headers stalls -> degraded
      for (let i = 0; i < 2; i += 1) {
        await fetchWithRetry(endpoint, { timeoutMs: 60, retries: 0 }).catch(() => {});
      }
      assert.equal(__getHealthForTesting().failureCount, 2);
      assert.equal(__getHealthForTesting().degraded, true);
      // one 200-then-stall mid-outage — must NOT erase the failures
      await fetchWithRetry(endpoint, { timeoutMs: 60, retries: 0 })
        .then((r) => r.json())
        .catch(() => {});
      const h = __getHealthForTesting();
      assert.equal(
        h.failureCount,
        3,
        "a 200-then-stall mid-outage must accrue a failure, not erase prior ones",
      );
      assert.equal(h.degraded, true, "banner must stay raised during the ongoing outage");
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // Facet #2 — recordApiSuccess is deferred until the body actually closes.
  // A 200 response that the caller never reads must not erase prior
  // failures; only a fully-consumed body records success.
  // ---------------------------------------------------------------------
  {
    const restore = installFetch(() => okJsonResponse({ ok: true }));
    try {
      __resetApiHealth();
      const endpoint = "/api/test-deferred-success";
      recordApiFailure(endpoint); // seed one failure
      assert.equal(__getHealthForTesting().failureCount, 1);

      // resolve headers but do NOT consume the body — success must not be recorded yet
      const res = await fetchWithRetry(endpoint, { timeoutMs: 5_000, retries: 0 });
      assert.equal(
        __getHealthForTesting().failureCount,
        1,
        "recordApiSuccess must be deferred until the body is consumed",
      );

      // now consume the body — success clears the prior failure
      await res.json();
      assert.equal(
        __getHealthForTesting().failureCount,
        0,
        "a fully-consumed successful body records success and clears prior failures",
      );
      assert.equal(__getHealthForTesting().degraded, false);
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // No-regression: a headers-stall timeout is still FetchError("timeout")
  // and still records a failure.
  // ---------------------------------------------------------------------
  {
    const restore = installFetch(neverResolvingFetch);
    try {
      __resetApiHealth();
      const endpoint = "/api/test-headers-stall";
      let caught: unknown = null;
      try {
        await fetchWithRetry(endpoint, { timeoutMs: 60, retries: 0 });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof FetchError, "headers-stall must be a FetchError");
      assert.equal((caught as FetchError).kind, "timeout");
      assert.equal(__getHealthForTesting().failureCount, 1);
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // No-regression: a normal 200 with a complete body resolves and records
  // success (deferred to body close).
  // ---------------------------------------------------------------------
  {
    const restore = installFetch(() => okJsonResponse({ models: [] }));
    try {
      __resetApiHealth();
      const endpoint = "/api/test-happy-path";
      const res = await fetchWithRetry(endpoint, { timeoutMs: 5_000, retries: 0 });
      const data = (await res.json()) as { models: [] };
      assert.deepEqual(data, { models: [] });
      assert.equal(__getHealthForTesting().failureCount, 0);
      assert.equal(__getHealthForTesting().degraded, false);
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // No-regression: a 5xx response is classified as FetchError("server") and
  // records a failure (retryable), and does NOT go through guardResponseBody.
  // ---------------------------------------------------------------------
  {
    const restore = installFetch(
      () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );
    try {
      __resetApiHealth();
      const endpoint = "/api/test-server-error";
      let caught: unknown = null;
      try {
        await fetchWithRetry(endpoint, { timeoutMs: 5_000, retries: 0 });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof FetchError);
      assert.equal((caught as FetchError).kind, "server");
      assert.equal((caught as FetchError).status, 503);
      assert.equal(__getHealthForTesting().failureCount, 1);
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // No-regression: a parent-signal abort during the headers phase propagates
  // the raw AbortError (not reclassified to FetchError) and records nothing.
  // ---------------------------------------------------------------------
  {
    const restore = installFetch(neverResolvingFetch);
    try {
      __resetApiHealth();
      const endpoint = "/api/test-parent-abort-headers";
      const parent = new AbortController();
      setTimeout(() => parent.abort(), 60);
      let caught: unknown = null;
      try {
        await fetchWithRetry(endpoint, {
          timeoutMs: 5_000,
          retries: 0,
          parentSignal: parent.signal,
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof DOMException, "parent-abort must propagate raw DOMException");
      assert.equal((caught as DOMException).name, "AbortError");
      assertNotFetchError(caught);
      assert.equal(__getHealthForTesting().failureCount, 0);
    } finally {
      restore();
    }
  }

  // ---------------------------------------------------------------------
  // No-regression: a 4xx (non-timeout, non-rate-limit) client error is not
  // recorded as a site failure (not retryable / not site-degraded signal).
  // ---------------------------------------------------------------------
  {
    const restore = installFetch(
      () => new Response(JSON.stringify({ error: "nope" }), { status: 404 }),
    );
    try {
      __resetApiHealth();
      const endpoint = "/api/test-client-error";
      let caught: unknown = null;
      try {
        await fetchWithRetry(endpoint, { timeoutMs: 5_000, retries: 0 });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof FetchError);
      assert.equal((caught as FetchError).kind, "client");
      assert.equal((caught as FetchError).status, 404);
      assert.equal(__getHealthForTesting().failureCount, 0, "client 4xx must not record a failure");
    } finally {
      restore();
    }
  }

  __resetApiHealth();
  console.log("fetchWithRetry body-stall classification + health checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
