import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchWithRetry, FetchError } from "../../lib/fetchWithRetry";
import { __getHealthForTesting, __resetApiHealth } from "../../lib/apiHealth";

/**
 * Real-fetch end-to-end reproduction (no globalThis.fetch mock) of the
 * "200 OK then body stalls" scenario, mirroring the bug report's Evidence
 * A/B/C. Uses the runtime's real globalThis.fetch against a local node:http
 * server. Node's fetch streams the chunked body; the internal timeout
 * aborts the in-flight body read, which guardResponseBody must reclassify as
 * FetchError("timeout").
 */

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function stallBodyHandler(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
  // emit one partial JSON chunk then never end() — the "200 then stall"
  res.write('{"ok":');
  // intentionally do not call res.end()
}

function neverHeadersHandler(_req: http.IncomingMessage, res: http.ServerResponse): void {
  // write headers but never end — the internal timer is what aborts
  res.writeHead(200, { "Content-Type": "application/json" });
}

function okJsonHandler(body: unknown): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
}

function ts(): number {
  return Date.now();
}

async function main() {
  // ---------------- Evidence A: body-stall surfaces as FetchError("timeout") ----------------
  {
    __resetApiHealth();
    const srv = await startServer(stallBodyHandler);
    try {
      const url = `http://127.0.0.1:${srv.port}/api/body-stall`;
      const headersAt = ts();
      const res = await fetchWithRetry(url, { timeoutMs: 300, retries: 0 });
      const headersElapsed = ts() - headersAt;

      // fetchWithRetry resolves once headers arrive (well under 300ms)
      assert.ok(
        headersElapsed < 280,
        `fetchWithRetry should resolve at headers (>200 OK), got ${headersElapsed}ms`,
      );

      let caught: unknown = null;
      const bodyAt = ts();
      try {
        await res.json();
      } catch (err) {
        caught = err;
      }
      const bodyElapsed = ts() - bodyAt;

      assert.ok(caught, "res.json() must reject on a body stall");
      // The internal timer starts at request start, so bodyElapsed (measured
      // from after headers arrive) can be less than timeoutMs. Measure total
      // elapsed from headersAt to confirm the abort fires within the window.
      const totalElapsed = ts() - headersAt;
      assert.ok(
        totalElapsed < 1200,
        `body rejection should fire near timeoutMs (~300ms total from request start), got ${totalElapsed}ms`,
      );

      // Facet #1: classified FetchError("timeout"), NOT a raw DOMException
      assert.ok(
        caught instanceof FetchError,
        `body-stall must be a FetchError, got ${(caught as Error)?.name}: ${(caught as Error)?.message}`,
      );
      assert.equal((caught as FetchError).kind, "timeout");
      assert.equal((caught as FetchError).retryable, true);
      assert.equal((caught as FetchError).status, null);

      // Facet #2: a body-stall records a FAILURE (not a success). After one,
      // failureCount must be 1, not 0.
      const h = __getHealthForTesting();
      assert.equal(h.failureCount, 1, `body-stall must record a failure, got ${h.failureCount}`);
    } finally {
      await srv.close();
    }
  }

  // ---------------- Evidence B: parent-abort during body read is raw DOMException ----------------
  {
    __resetApiHealth();
    const srv = await startServer(stallBodyHandler);
    try {
      const url = `http://127.0.0.1:${srv.port}/api/parent-abort`;
      const parent = new AbortController();
      const resPromise = fetchWithRetry(url, {
        timeoutMs: 5_000,
        retries: 0,
        parentSignal: parent.signal,
      });
      // abort the parent well before the internal timeout so only the parent fires
      setTimeout(() => parent.abort(), 100);
      let caught: unknown = null;
      try {
        const res = await resPromise;
        await res.json();
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "parent-abort during body must reject res.json()");
      // Parent cancel must be a raw DOMException, NOT a FetchError
      assert.ok(
        caught instanceof DOMException,
        `parent-abort must be a raw DOMException, got ${(caught as Error)?.name}`,
      );
      assert.equal((caught as DOMException).name, "AbortError");
      assert.equal(caught instanceof FetchError, false);
      assert.equal(parent.signal.aborted, true);
      // not a recorded failure
      const h = __getHealthForTesting();
      assert.equal(h.failureCount, 0, "parent-abort must not record a failure");
    } finally {
      await srv.close();
    }
  }

  // ---------------- Evidence C: health end-to-end across an outage ----------------
  {
    __resetApiHealth();
    const stallSrv = await startServer(stallBodyHandler);
    const neverHeadersSrv = await startServer(neverHeadersHandler);
    try {
      const stallUrl = `http://127.0.0.1:${stallSrv.port}/api/outage`;
      const neverUrl = `http://127.0.0.1:${neverHeadersSrv.port}/api/outage`;
      const ep = "/api/outage";

      // A: 2x headers-stall -> degraded, failureCount 2
      async function twoHeadersStalls(): Promise<void> {
        for (let i = 0; i < 2; i += 1) {
          await fetchWithRetry(neverUrl, { timeoutMs: 200, retries: 0 }).catch((e: unknown) => {
            assert.ok(
              e instanceof FetchError && e.kind === "timeout",
              `headers-stall must be FetchError("timeout"), got ${(e as Error)?.name}`,
            );
          });
        }
      }
      await twoHeadersStalls();
      let h = __getHealthForTesting();
      assert.equal(h.failureCount, 2, "A: two headers-stalls -> failureCount 2");
      assert.equal(h.degraded, true, "A: two headers-stalls -> degraded true");

      // B: 2x body-stall -> accrues failures (was failureCount 0 / degraded false before fix)
      __resetApiHealth();
      for (let i = 0; i < 2; i += 1) {
        await fetchWithRetry(stallUrl, { timeoutMs: 200, retries: 0 })
          .then((r) => r.json())
          .catch(() => {});
      }
      h = __getHealthForTesting();
      assert.equal(
        h.failureCount,
        2,
        `B: two body-stalls must accrue 2 failures (was 0 before fix), got ${h.failureCount}`,
      );
      assert.equal(h.degraded, true, "B: body-stall outage must raise the banner");

      // C: 2 headers-stalls then one body-stall -> must NOT erase (was 0 before fix)
      __resetApiHealth();
      await twoHeadersStalls();
      assert.equal(__getHealthForTesting().failureCount, 2);
      await fetchWithRetry(stallUrl, { timeoutMs: 200, retries: 0 })
        .then((r) => r.json())
        .catch(() => {});
      h = __getHealthForTesting();
      assert.equal(
        h.failureCount,
        3,
        `C: mid-outage body-stall must accrue (was erasing to 0 before fix), got ${h.failureCount}`,
      );
      assert.equal(h.degraded, true, "C: banner stays raised mid-outage");

      // D: a fully-consumed successful body clears prior failures (no regression)
      const okSrv = await startServer(okJsonHandler({ ok: true }));
      try {
        const okUrl = `http://127.0.0.1:${okSrv.port}/api/outage`;
        await fetchWithRetry(okUrl, { timeoutMs: 1_000, retries: 0 })
          .then((r) => r.json())
          .then((d) => assert.deepEqual(d, { ok: true }));
        h = __getHealthForTesting();
        assert.equal(
          h.failureCount,
          0,
          "a fully-consumed success must defer-then-record success, clearing prior failures",
        );
      } finally {
        await okSrv.close();
      }
    } finally {
      await stallSrv.close();
      await neverHeadersSrv.close();
    }
  }

  __resetApiHealth();
  console.log("fetchWithRetry real-fetch body-stall + health end-to-end checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
