import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const storageDir = ".custom-build-storage/unit-import-request";
const originalEnv = { ...process.env };
let ownerId: string | null = "00000000-0000-4000-8000-000000000001";
let storedBytes = 0;
let localPreparations = 0;
let failCreate = false;
let uploadedPath = "";
const created: Record<string, unknown>[] = [];
const fakePrisma = {
  customBuild: {
    aggregate: async () => ({ _sum: { storedByteSize: storedBytes } }),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const artifact = (data.artifacts as { create: Record<string, unknown> }).create;
      uploadedPath = join(storageDir, String(artifact.path));
      const source = await readFile(uploadedPath);
      assert.equal(createHash("sha256").update(source).digest("hex"), artifact.sha256);
      assert.equal(artifact.sha256, artifact.sourceBuildSha256);
      assert.equal(source.byteLength, artifact.storedByteSize);
      assert.equal(JSON.parse(source.toString()).tool, "voxel.exec");
      assert.equal(artifact.kind, "raw_text_debug");
      assert.equal(artifact.encoding, "identity");
      if (failCreate) throw new Error("Database unavailable");
      created.push(data);
      return { ...data, createdAt: new Date(), updatedAt: new Date(), artifacts: [artifact] };
    },
  },
  customBuildStatsDaily: { upsert: async () => ({}) },
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(fakePrisma),
};
(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

for (const [path, exports] of [
  ["../../../lib/auth/request", { getAuthenticatedUserId: async () => ownerId }],
  ["../../../lib/voxel/localWorldServer", {
    persistLocalVoxelWorld: async () => {
      localPreparations += 1;
      throw new Error("ENOSPC: no space left on device, write");
    },
  }],
] as const) {
  const id = require.resolve(path);
  const stub = new Module(id);
  stub.exports = exports;
  stub.loaded = true;
  require.cache[id] = stub;
}

function request(gridSize = 8192, code = "box(0,0,0,3,3,3,'stone');") {
  return new Request("https://alpha.minebench.ai/api/local/voxel-exec", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://alpha.minebench.ai" },
    body: JSON.stringify({ code, gridSize, palette: "simple", seed: 1849 }),
  });
}

async function main() {
  process.env.VERCEL = "1";
  process.env.MINEBENCH_ENABLE_LOCAL_EXEC_API = "1";
  process.env.CUSTOM_BUILD_STORAGE_BUCKET = "__local_fs__";
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = storageDir;
  const { POST } = require("../../../app/api/local/voxel-exec/route") as {
    POST: (request: Request) => Promise<Response>;
  };

  for (const gridSize of [2048, 8192]) {
    const response = await POST(request(gridSize));
    assert.equal(response.status, 202, "hosted imports must queue without using Vercel's temporary disk");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const { generation } = await response.json();
    assert.equal(generation.status, "queued");
    assert.equal(generation.gridSize, gridSize);
    assert.equal(generation.viewerUrl, null);
    const data = created.at(-1)!;
    assert.equal(data.ownerId, ownerId);
    assert.equal(data.generationMode, "import");
    assert.equal(data.modelKind, "import");
    assert.equal(data.modelId, "voxel.exec");
    assert.equal(data.secret, undefined, "imports never store a provider credential");
    assert.equal((data.jobs as { create: { type: string } }).create.type, "generate");
  }
  assert.equal(localPreparations, 0);

  ownerId = null;
  assert.equal((await POST(request())).status, 401);
  ownerId = "00000000-0000-4000-8000-000000000001";
  assert.equal((await POST(request(4096))).status, 400);
  assert.equal((await POST(request(8192, " ".repeat(600_001)))).status, 413);
  assert.equal(created.length, 2);

  storedBytes = 1024 ** 3;
  assert.equal((await POST(request())).status, 409, "imports retain the saved-build storage limit");
  storedBytes = 0;
  failCreate = true;
  assert.equal((await POST(request())).status, 500);
  await assert.rejects(stat(uploadedPath), { code: "ENOENT" }, "failed queue creation removes its uploaded source");
  assert.equal(created.length, 2);
  failCreate = false;

  assert.equal((await POST(request(64))).status, 200, "small imports remain inline");
  delete process.env.VERCEL;
  assert.equal((await POST(request())).status, 400);
  assert.equal(localPreparations, 1, "local development retains its existing execution path");
  console.log("hosted pasted imports queue without web artifact preparation");
}

void main().finally(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(storageDir, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
