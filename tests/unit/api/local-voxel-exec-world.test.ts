import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { gunzipSync as browserGunzipSync } from "fflate";
import { GET, POST } from "../../../app/api/local/voxel-exec/route";
import { decodeBinaryVoxelBuild } from "../../../lib/voxel/binaryBuild";
import { LOCAL_VOXEL_WORLD_SOURCE_PART_KEY } from "../../../lib/voxel/localWorldServer";
import { unpackVoxelBlocks } from "../../../lib/voxel/packedBlocks";
import { voxelWorldPartUrl, type VoxelWorldDelivery } from "../../../lib/voxel/world";
import { decodeWorldMeshPayload } from "../../../lib/voxel/worldMesh";

type LocalWorldBody = {
  build: {
    version: "1.0";
    blocks: unknown[];
    boxes?: unknown[];
    lines?: unknown[];
    world: VoxelWorldDelivery;
  };
  warnings: string[];
  blockCount: number;
  bounds: unknown;
};

async function jsonPost(body: unknown) {
  return POST(new Request("http://localhost:3000/api/local/voxel-exec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function getWorldPart(world: VoxelWorldDelivery, key: string) {
  return GET(new Request(new URL(voxelWorldPartUrl(world, key), "http://localhost:3000")));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rawUploadPost(body: BodyInit, init: RequestInit = {}) {
  return POST(new Request(
    "http://localhost:3000/api/local/voxel-exec?gridSize=8192&palette=simple",
    {
      method: "POST",
      headers: { "Content-Type": "application/vnd.minebench.build+json" },
      body,
      ...init,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  ));
}

function pendingRawUpload() {
  let close = (_suffix: string) => {};
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"version":"1.0","blocks":['));
      close = (suffix: string) => {
        controller.enqueue(new TextEncoder().encode(suffix));
        controller.close();
      };
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, close, get cancelled() { return cancelled; } };
}

async function sourceTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("minebench-build-"))
    .sort();
}

async function main() {
  const response = await jsonPost({
    code: 'block(0,0,0,"stone"); block(1,0,0,"cobblestone");',
    gridSize: 8192,
    palette: "simple",
    seed: 123,
  });
  assert.equal(response.status, 200);
  const body = await response.json() as LocalWorldBody;
  assert.equal(body.build.version, "1.0");
  assert.deepEqual(body.build.blocks, []);
  assert.equal("boxes" in body.build, false);
  assert.equal(body.blockCount, 2);
  assert.deepEqual(body.warnings, []);
  assert.match(body.build.world.partBaseUrl ?? "", /^\/api\/local\/voxel-exec\?world=[0-9a-f-]{36}$/);
  assert.equal(body.build.world.manifest.exactBlockCount, 2);

  const mixed = body.build.world.manifest.regions?.find((region) => region.kind === "mixed");
  assert.ok(mixed?.kind === "mixed");
  assert.equal(mixed.data.kind, "opaque");
  assert.equal("bucket" in mixed.data, false);
  assert.equal("path" in mixed.data, false);

  const mixedResponse = await getWorldPart(body.build.world, mixed.data.key);
  assert.equal(mixedResponse.status, 200);
  assert.equal(mixedResponse.headers.get("Content-Encoding"), "gzip");
  const mixedBytes = new Uint8Array(await mixedResponse.arrayBuffer());
  assert.equal(mixedBytes[0], 0x1f);
  assert.equal(mixedBytes[1], 0x8b);
  assert.deepEqual(unpackVoxelBlocks(decodeBinaryVoxelBuild(browserGunzipSync(mixedBytes))), [
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "cobblestone" },
  ]);

  const sourceResponse = await getWorldPart(body.build.world, LOCAL_VOXEL_WORLD_SOURCE_PART_KEY);
  assert.equal(sourceResponse.status, 200);
  assert.equal(sourceResponse.headers.get("Content-Encoding"), "gzip");
  const source = JSON.parse(gunzipSync(new Uint8Array(await sourceResponse.arrayBuffer())).toString("utf8"));
  assert.deepEqual(source, {
    version: "1.0",
    blocks: [
      { x: 0, y: 0, z: 0, type: "stone" },
      { x: 1, y: 0, z: 0, type: "cobblestone" },
    ],
  });

  assert.equal((await getWorldPart(body.build.world, "manifest")).status, 404);
  assert.equal((await GET(new Request("http://localhost:3000/api/local/voxel-exec?world=not-a-uuid&part=source"))).status, 404);
  assert.equal((await GET(new Request(new URL(`${body.build.world.partBaseUrl}&part=../source`, "http://localhost:3000")))).status, 404);

  const firstHeldUpload = pendingRawUpload();
  const firstHeldResponse = rawUploadPost(firstHeldUpload.stream);
  const secondHeldUpload = pendingRawUpload();
  const secondHeldAbort = new AbortController();
  const secondHeldResponse = rawUploadPost(secondHeldUpload.stream, { signal: secondHeldAbort.signal });
  let overloadedRawCancelled = false;
  const overloadedRawResponse = await rawUploadPost(new ReadableStream<Uint8Array>({
    cancel() {
      overloadedRawCancelled = true;
    },
  }));
  assert.equal(overloadedRawResponse.status, 429);
  assert.equal(overloadedRawResponse.headers.get("Retry-After"), "10");
  assert.equal(overloadedRawCancelled, true);
  const overloadedJsonResponse = await jsonPost({
    code: 'block(0,0,0,"stone");',
    gridSize: 8192,
    palette: "simple",
    seed: 1,
  });
  assert.equal(overloadedJsonResponse.status, 429);
  assert.equal(overloadedJsonResponse.headers.get("Retry-After"), "10");
  secondHeldAbort.abort();
  firstHeldUpload.close("}");
  assert.equal((await firstHeldResponse).status, 400);
  assert.equal((await secondHeldResponse).status, 499);
  assert.equal(secondHeldUpload.cancelled, true);

  const rawUpload = `{
  "version": "1.0",
  "boxes": [
    { "x1": 4, "y1": 0, "z1": 0, "x2": 5, "y2": 0, "z2": 0, "type": "stone" }
  ],
  "lines": [
    { "from": { "x": 6, "y": 0, "z": 0 }, "to": { "x": 7, "y": 0, "z": 0 }, "type": "cobblestone" }
  ],
  "blocks": [
    { "x": 8, "y": 0, "z": 0, "type": "stone" }
  ]
}`;
  const rawResponse = await rawUploadPost(rawUpload);
  assert.equal(rawResponse.status, 200);
  const rawBody = await rawResponse.json() as LocalWorldBody;
  assert.equal(rawBody.blockCount, 5);
  assert.deepEqual(rawBody.build.blocks, []);
  assert.equal(rawBody.build.world.manifest.source.sha256, sha256Text(rawUpload));
  assert.ok(rawBody.build.world.manifest.regions?.some((region) => region.kind === "mixed"));
  const rawSourceResponse = await getWorldPart(rawBody.build.world, LOCAL_VOXEL_WORLD_SOURCE_PART_KEY);
  assert.equal(rawSourceResponse.status, 200);
  const rawSource = gunzipSync(new Uint8Array(await rawSourceResponse.arrayBuffer())).toString("utf8");
  assert.equal(rawSource, rawUpload);

  for (const world of [body.build.world, rawBody.build.world]) {
    const mesh = world.manifest.mesh?.batches[0];
    assert.ok(mesh, "mixed local worlds prepare mesh artifacts");
    const meshResponse = await getWorldPart(world, mesh.data.key);
    assert.equal(meshResponse.status, 200, "JSON execution and raw upload deliver their prepared meshes");
    assert.equal(meshResponse.headers.get("Content-Encoding"), "gzip");
    const meshBytes = new Uint8Array(await meshResponse.arrayBuffer());
    assert.equal(createHash("sha256").update(meshBytes).digest("hex"), mesh.data.sha256);
    assert.equal(decodeWorldMeshPayload(browserGunzipSync(meshBytes)).filteredBlockCount, mesh.blockCount);

    const worldId = new URL(world.partBaseUrl!, "http://localhost:3000").searchParams.get("world")!;
    const directory = join(tmpdir(), "minebench-local-voxel-worlds", worldId);
    const unlistedKey = `mesh-${world.manifest.mesh!.version}-${world.manifest.mesh!.batches.length}`;
    try {
      await writeFile(join(directory, unlistedKey), meshBytes);
      assert.equal((await getWorldPart(world, unlistedKey)).status, 404, "mesh delivery requires a manifest reference");
      const corruptBytes = meshBytes.slice();
      corruptBytes[corruptBytes.length - 1] ^= 1;
      await writeFile(join(directory, mesh.data.key), corruptBytes);
      assert.equal((await getWorldPart(world, mesh.data.key)).status, 404, "mesh delivery rejects checksum mismatches");
    } finally {
      await writeFile(join(directory, mesh.data.key), meshBytes);
      await rm(join(directory, unlistedKey), { force: true });
    }
  }

  const beforeFailure = await sourceTempDirs();
  const failedRawResponse = await rawUploadPost('{"version":"1.0","blocks":[{"x":0,"y":0,"z":0}]}');
  assert.equal(failedRawResponse.status, 400);
  assert.deepEqual(await sourceTempDirs(), beforeFailure);

  let canceledMalformedBody = false;
  const malformedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"version":"1.0","blocks":[}'));
    },
    cancel() {
      canceledMalformedBody = true;
    },
  });
  const malformedResponse = await rawUploadPost(malformedBody);
  assert.equal(malformedResponse.status, 400);
  assert.equal(canceledMalformedBody, true);
  assert.deepEqual(await sourceTempDirs(), beforeFailure);

  console.log("local voxel world delivery checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
