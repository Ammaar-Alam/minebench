import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import { openAiCompatibleGenerateText } from "../../../lib/ai/providers/openaiCompatible";

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

async function main() {
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      response.writeHead(500, {
        "Content-Type": "application/json",
        "x-request-id": "rid-123",
      });
      response.end(JSON.stringify({ error: { message: "boom totally exploded" } }));
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;

    let caught: unknown;
    try {
      await openAiCompatibleGenerateText({
        modelId: "example-reasoner",
        apiKey: "test-key",
        baseUrl: `https://models.example.test:${port}/v1/chat/completions`,
        system: "system",
        user: "user",
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error, "provider should throw on 5xx");
    assert.equal(
      (caught as Error).message,
      'Custom API error 500 (request rid-123): {"error":{"message":"boom totally exploded"}}',
      "non-2xx detail (status, request id, error body) must be preserved verbatim, not re-wrapped",
    );
    console.log("custom provider non-2xx error detail checks passed");
  } finally {
    Object.defineProperty(dns, "lookup", { configurable: true, value: originalLookup });
    Object.defineProperty(https, "request", { configurable: true, value: originalHttpsRequest });
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
