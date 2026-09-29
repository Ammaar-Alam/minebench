import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import type { GenerateEvent } from "../../../lib/ai/types";

const require = createRequire(import.meta.url);
let userId: string | null = null;
const gallery = require("../../../lib/gallery/service") as typeof import("../../../lib/gallery/service");
for (const [path, exports] of [
  ["../../../lib/auth/request", { getAuthenticatedUserId: async () => userId }],
  ["../../../lib/gallery/service", {
    ...gallery,
    requireMineBenchAdmin: async (id: string) => {
      if (id !== "admin") throw new gallery.GalleryServiceError("forbidden", "MineBench admin access required.");
    },
  }],
] as const) {
  const id = require.resolve(path);
  const stub = new Module(id);
  stub.exports = exports;
  stub.loaded = true;
  require.cache[id] = stub;
}
const { POST } = require("../../../app/api/generate/route") as { POST: (request: Request) => Promise<Response> };

async function main() {
  const originalFetch = globalThis.fetch;
  const originalVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  try {
    for (const gridSize of [256, 2048, 8192]) {
      let providerRequests = 0;
      const call = {
        tool: "voxel.exec",
        input: {
          gridSize, palette: "simple", seed: 1,
          code: 'for(let i=0;i<12000;i++) block(i%120,Math.floor(i/120),0,"stone"); box(0,0,4,3,3,7,"glass");',
        },
      };
      globalThis.fetch = async () => {
        providerRequests += 1;
        return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(call) } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
      };
      const response = await POST(new Request("http://localhost:3000/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "A stone plaza with a glass sculpture", gridSize, palette: "simple",
          modelKeys: ["qwen_qwen3_8_max"], providerKeys: { openrouter: "test-openrouter-key" },
        }),
      }));
      if (gridSize > 512) {
        assert.equal(response.status, 400);
        assert.equal(providerRequests, 0, "oversized anonymous requests never call a provider");
        continue;
      }
      assert.equal(response.status, 200);
      const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)) as GenerateEvent[];
      assert.deepEqual(events.filter((event) => event.type === "error"), []);
      const result = events.find((event) => event.type === "result");
      assert.ok(result);
      assert.equal(result.modelKey, "qwen_qwen3_8_max");
      assert.equal(result.metrics.blockCount, 12_064);
      assert.equal(result.voxelBuild.blocks.length, 12_000);
      assert.equal(result.voxelBuild.boxes?.length, 1);
    }

    let providerRequests = 0;
    globalThis.fetch = async () => {
      providerRequests += 1;
      throw new Error("Preview must not contact the provider");
    };
    for (const account of [null, "member", "admin"]) {
      userId = account;
      for (const gridSize of [32, 512, 2048, 8192]) {
        for (const preview of [false, true]) {
          const response = await POST(new Request(`http://localhost:3000/api/generate${preview ? "?preview=1" : ""}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: !preview && gridSize > 512 ? "A stone plaza" : "", gridSize, palette: "simple",
              modelKeys: ["qwen_qwen3_8_max"], providerKeys: { openrouter: "test-openrouter-key" },
            }),
          }));
          const expected = !preview ? 400 : gridSize <= 512 || account === "admin" ? 200 : account ? 403 : 401;
          assert.equal(response.status, expected, `${account ?? "anonymous"}, grid ${gridSize}, preview ${preview}`);
          if (expected === 200) {
            const { request } = await response.json();
            assert.equal(request.method, "POST");
            assert.equal(request.headers.authorization, "[hidden]");
            assert.match(JSON.stringify(request.body), new RegExp(String(gridSize)));
          }
          assert.equal(providerRequests, 0, "previews and rejected large requests never contact a provider");
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }
  console.log("generation size and request preview access checks passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
