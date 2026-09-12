import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import type { IncomingMessage, RequestOptions, Server } from "node:http";
import https from "node:https";
import { openAiCompatibleGenerateText } from "../../../lib/ai/providers/openaiCompatible";

type Mode = "streamSocketDrop" | "jsonSocketDrop" | "streamFiveDeltas" | "stallAfterOne" | "jsonOk";

const originalLookup = dns.lookup;
const originalHttpsRequest = https.request;

Object.defineProperty(dns, "lookup", {
  configurable: true,
  value: async () => [{ address: "93.184.216.34", family: 4 }],
});
Object.defineProperty(https, "request", {
  configurable: true,
  value: ((
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => http.request({ ...options, hostname: "127.0.0.1", family: 4 }, callback)) as typeof https.request,
});

function createVariantServer(mode: Mode): Server {
  return http.createServer((request, response) => {
    response.on("error", () => {});
    request.on("data", () => {});
    request.on("end", () => {
      if (mode === "jsonOk") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
        return;
      }
      if (mode === "jsonSocketDrop") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"choices":[{"message":{"content":"partial');
        setTimeout(() => response.socket?.destroy(), 20);
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "streamSocketDrop") {
        response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
        setTimeout(() => response.socket?.destroy(), 20);
        return;
      }
      if (mode === "stallAfterOne") {
        response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
        return;
      }
      let count = 0;
      let done = false;
      response.on("close", () => {
        done = true;
      });
      const tick = () => {
        if (done) return;
        count += 1;
        response.write(`data: {"choices":[{"delta":{"content":"D${count}"}}]}\n\n`);
        if (count >= 5) {
          response.end();
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  });
}

interface VariantOptions {
  mode: Mode;
  stream: boolean;
  settleTimeoutMs: number;
  signal?: AbortSignal;
  abort?: () => void;
  abortOnFirstDelta?: boolean;
}

interface VariantOutcome {
  settled: boolean;
  value: string | undefined;
  errorName: string | undefined;
  errorMessage: string | undefined;
  errorCode: string | undefined;
  deltasReceived: number;
  signalAborted: boolean;
}

async function runVariant(opts: VariantOptions): Promise<VariantOutcome> {
  const server = createVariantServer(opts.mode);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  let deltasReceived = 0;
  const onDelta = opts.stream
    ? (delta: string) => {
        deltasReceived += 1;
        if (opts.abortOnFirstDelta && deltasReceived === 1) opts.abort?.();
      }
    : undefined;

  const call = openAiCompatibleGenerateText({
    modelId: "example-reasoner",
    apiKey: "test-key",
    baseUrl: `https://models.example.test:${port}/v1/chat/completions`,
    system: "system",
    user: "user",
    ...(opts.stream ? { onDelta } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  let settled = false;
  let value: string | undefined;
  let error: unknown;

  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), opts.settleTimeoutMs),
  );

  try {
    const raced = await Promise.race([
      call
        .then((r) => {
          value = r.text;
          return "settled" as const;
        })
        .catch((e) => {
          error = e;
          return "settled" as const;
        }),
      timeout,
    ]);
    settled = raced === "settled";
  } finally {
    if (!settled) opts.abort?.();
    server.closeAllConnections?.();
    try {
      await call;
    } catch (e) {
      error = e;
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  return {
    settled,
    value,
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : undefined,
    errorCode:
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined,
    deltasReceived,
    signalAborted: opts.signal?.aborted ?? false,
  };
}

async function main() {
  try {
    // Variant 1: streaming 2xx then socket drop mid-stream -> polished error
    const v1 = await runVariant({ mode: "streamSocketDrop", stream: true, settleTimeoutMs: 3000 });
    assert.equal(v1.settled, true, "variant 1 should settle");
    assert.equal(v1.errorMessage, "Custom API request failed", "variant 1 should polish mid-stream socket drop");

    // Variant 2: non-streaming 2xx then socket drop mid-body -> polished error
    const v2 = await runVariant({ mode: "jsonSocketDrop", stream: false, settleTimeoutMs: 3000 });
    assert.equal(v2.settled, true, "variant 2 should settle");
    assert.equal(v2.errorMessage, "Custom API request failed", "variant 2 should polish mid-body socket drop");

    // Variant 3: caller aborts after first delta while upstream keeps streaming
    // -> abort honored (call torn down) instead of draining the full billed completion
    const c3 = new AbortController();
    const v3 = await runVariant({
      mode: "streamFiveDeltas",
      stream: true,
      settleTimeoutMs: 3000,
      signal: c3.signal,
      abort: () => c3.abort(),
      abortOnFirstDelta: true,
    });
    assert.equal(v3.settled, true, "variant 3 should settle");
    assert.equal(v3.errorMessage, "Custom API request failed", "variant 3 should honor the mid-stream abort");
    assert.equal(v3.signalAborted, true);
    assert.ok(v3.deltasReceived < 5, `variant 3 should not drain the full completion (got ${v3.deltasReceived})`);

    // Variant 4: upstream stalls after one chunk, caller aborts -> settles (no app-side hang)
    const c4 = new AbortController();
    const v4 = await runVariant({
      mode: "stallAfterOne",
      stream: true,
      settleTimeoutMs: 3000,
      signal: c4.signal,
      abort: () => c4.abort(),
      abortOnFirstDelta: true,
    });
    assert.equal(v4.settled, true, "variant 4 should settle despite upstream stall");
    assert.equal(v4.errorMessage, "Custom API request failed", "variant 4 should honor caller abort on stalled stream");
    assert.equal(v4.signalAborted, true);

    // Variant 5: production-style watchdog (AbortSignal.any) deadline fires post-headers
    // -> call torn down instead of hanging (the 90-min watchdog defeat case)
    const c5 = new AbortController();
    const deadline5 = AbortSignal.timeout(200);
    const combined5 = AbortSignal.any([c5.signal, deadline5]);
    const v5 = await runVariant({
      mode: "stallAfterOne",
      stream: true,
      settleTimeoutMs: 3000,
      signal: combined5,
      abort: () => c5.abort(),
    });
    assert.equal(v5.settled, true, "variant 5 should settle when the watchdog deadline fires");
    assert.equal(v5.errorMessage, "Custom API request failed", "variant 5 should honor the watchdog deadline");
    assert.equal(v5.signalAborted, true);

    // Regression: streaming happy path (no abort) still returns the full streamed text
    const v6 = await runVariant({ mode: "streamFiveDeltas", stream: true, settleTimeoutMs: 3000 });
    assert.equal(v6.settled, true, "happy-path streaming should settle");
    assert.equal(v6.errorMessage, undefined, "happy-path streaming should not throw");
    assert.equal(v6.value, "D1D2D3D4D5", "happy-path streaming should return the full streamed text");
    assert.equal(v6.deltasReceived, 5);

    // Regression: non-streaming JSON happy path still returns the parsed content
    const v7 = await runVariant({ mode: "jsonOk", stream: false, settleTimeoutMs: 3000 });
    assert.equal(v7.settled, true, "happy-path JSON should settle");
    assert.equal(v7.errorMessage, undefined, "happy-path JSON should not throw");
    assert.equal(v7.value, "done");

    console.log("custom provider abort-during-body checks passed");
  } finally {
    Object.defineProperty(dns, "lookup", { configurable: true, value: originalLookup });
    Object.defineProperty(https, "request", { configurable: true, value: originalHttpsRequest });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
