import assert from "node:assert/strict";
import dns from "node:dns/promises";

import { generateVoxelBuild } from "../../../lib/ai/generateVoxelBuild";

const originalLookup = dns.lookup;
let lookupCount = 0;

Object.defineProperty(dns, "lookup", {
  configurable: true,
  value: async () => {
    lookupCount += 1;
    throw Object.assign(new Error("Temporary DNS resolver failure"), {
      code: "EAI_AGAIN",
    });
  },
});

async function main() {
  const retries: number[] = [];
  let providerCallCount = 0;
  const transientResult = await generateVoxelBuild({
    model: {
      key: "custom_dns_retry",
      provider: "custom",
      modelId: "custom-model",
      displayName: "Custom model",
      baseUrl: "https://api.example.test",
    },
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 3,
    enableTools: false,
    providerKeys: { custom: "test-custom-key" },
    allowServerKeys: false,
    onRetry: (attempt) => retries.push(attempt),
    onProviderRequest: () => {
      providerCallCount += 1;
    },
  });

  assert.equal(transientResult.ok, false);
  assert.equal(lookupCount, 3, "transient DNS failures should use every safe outer retry");
  assert.deepEqual(retries, [2, 3]);
  assert.equal(
    providerCallCount,
    0,
    "DNS preflight failures must not count as outbound provider calls",
  );

  retries.length = 0;
  const invalidUrlResult = await generateVoxelBuild({
    model: {
      key: "custom_invalid_url",
      provider: "custom",
      modelId: "custom-model",
      displayName: "Custom model",
      baseUrl: "not a URL",
    },
    prompt: "small tower",
    gridSize: 64,
    palette: "simple",
    maxAttempts: 3,
    enableTools: false,
    providerKeys: { custom: "test-custom-key" },
    allowServerKeys: false,
    onRetry: (attempt) => retries.push(attempt),
  });

  assert.equal(invalidUrlResult.ok, false);
  assert.match(invalidUrlResult.error, /Invalid custom API server URL/);
  assert.deepEqual(retries, [], "deterministic custom URL failures should stop immediately");

  console.log("custom api preflight retry checks passed");
}

main()
  .finally(() => {
    Object.defineProperty(dns, "lookup", {
      configurable: true,
      value: originalLookup,
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
