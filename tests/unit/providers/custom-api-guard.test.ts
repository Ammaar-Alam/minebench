import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { resolveCustomApiTarget } from "../../../lib/ai/providers/customApiGuard";

const originalLookup = dns.lookup;

Object.defineProperty(dns, "lookup", {
  configurable: true,
  value: async (hostname: string) => {
    return [{ address: "93.184.216.34", family: 4 }];
  },
});

async function main() {
  // Standard OpenAI root
  const root = await resolveCustomApiTarget("https://api.openai.com");
  assert.equal(root.url.toString(), "https://api.openai.com/v1/chat/completions");

  // Standard OpenAI root with trailing slash
  const rootSlash = await resolveCustomApiTarget("https://api.openai.com/");
  assert.equal(rootSlash.url.toString(), "https://api.openai.com/v1/chat/completions");

  // Standard OpenAI /v1
  const v1 = await resolveCustomApiTarget("https://api.openai.com/v1");
  assert.equal(v1.url.toString(), "https://api.openai.com/v1/chat/completions");

  // Standard OpenAI /v1 with trailing slash
  const v1Slash = await resolveCustomApiTarget("https://api.openai.com/v1/");
  assert.equal(v1Slash.url.toString(), "https://api.openai.com/v1/chat/completions");

  // Full /v1/chat/completions
  const full = await resolveCustomApiTarget("https://api.openai.com/v1/chat/completions");
  assert.equal(full.url.toString(), "https://api.openai.com/v1/chat/completions");

  // Full /v1/chat/completions with trailing slash
  const fullSlash = await resolveCustomApiTarget("https://api.openai.com/v1/chat/completions/");
  assert.equal(fullSlash.url.toString(), "https://api.openai.com/v1/chat/completions");

  // ByteDance VolcEngine Ark Coding Plan subpath /api/coding/v3
  const arkCoding = await resolveCustomApiTarget("https://ark.cn-beijing.volces.com/api/coding/v3");
  assert.equal(
    arkCoding.url.toString(),
    "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
  );

  // ByteDance VolcEngine Ark Coding Plan full endpoint /api/coding/v3/chat/completions
  const arkCodingFull = await resolveCustomApiTarget(
    "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
  );
  assert.equal(
    arkCodingFull.url.toString(),
    "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
  );

  // ByteDance VolcEngine Ark standard /api/v3
  const arkV3 = await resolveCustomApiTarget("https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(
    arkV3.url.toString(),
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );

  // Cloudflare AI Gateway custom subpath
  const cf = await resolveCustomApiTarget(
    "https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/openai",
  );
  assert.equal(
    cf.url.toString(),
    "https://gateway.ai.cloudflare.com/v1/account-id/my-gateway/openai/chat/completions",
  );

  // URL with query params
  const withQuery = await resolveCustomApiTarget("https://api.example.com/v1?version=2024-02-01");
  assert.equal(
    withQuery.url.toString(),
    "https://api.example.com/v1/chat/completions?version=2024-02-01",
  );

  console.log("custom api guard target resolution checks passed");
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
