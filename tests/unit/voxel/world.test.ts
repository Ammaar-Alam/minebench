import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  VOXEL_WORLD_MIXED_LEAF_SIZE,
  VOXEL_WORLD_REGION_PAGE_REF_LIMIT,
  parseVoxelWorldManifest,
  parseVoxelWorldRegionPage,
  toOpaqueVoxelWorldManifest,
  voxelWorldPartUrl,
  type VoxelWorldManifest,
  type VoxelWorldManifestParseResult,
  type VoxelWorldRegionPage,
  type VoxelWorldRegionPageParseResult,
} from "../../../lib/voxel/world";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const ENCODER = new TextEncoder();

function assertBad(
  result: VoxelWorldManifestParseResult | VoxelWorldRegionPageParseResult,
  message: RegExp,
) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, message);
}

function assertManifest(result: VoxelWorldManifestParseResult): VoxelWorldManifest {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function assertPage(result: VoxelWorldRegionPageParseResult): VoxelWorldRegionPage {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function source() {
  return {
    format: "build_json",
    sha256: SHA,
    evaluatorVersion: 1,
  };
}

function opaquePart(key: string, sha256 = SHA) {
  return {
    kind: "opaque",
    key,
    encoding: "gzip",
    byteSize: 128,
    sha256,
  };
}

function storedPart(key: string) {
  return {
    kind: "stored",
    key,
    bucket: "builds",
    path: `custom-builds/v1/world/${key}.mbv4.gz`,
    encoding: "gzip",
    byteSize: 128,
    sha256: SHA,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gzipJson(value: unknown): Uint8Array {
  return new Uint8Array(gzipSync(ENCODER.encode(JSON.stringify(value))));
}

function responseBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const inlineManifest = {
  kind: "voxel_world",
  version: 1,
  gridSize: 8192,
  palette: "simple",
  bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 192, y: 64, z: 128 } },
  exactBlockCount: 262_156,
  leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
  source: source(),
  regions: [
    {
      kind: "uniform",
      key: "solid-0",
      origin: { x: 0, y: 0, z: 0 },
      size: { x: 64, y: 64, z: 64 },
      type: "stone",
      blockCount: 262_144,
    },
    {
      kind: "mixed",
      key: "mixed-0",
      origin: { x: 80, y: 4, z: 3 },
      size: { x: 63, y: 7, z: 64 },
      blockCount: 12,
      format: "mbv4",
      coordinateSpace: "local",
      data: opaquePart("mixed-0-data"),
    },
  ],
};

{
  const manifest = assertManifest(parseVoxelWorldManifest(inlineManifest));
  assert.equal(manifest.exactBlockCount, 262_156);
  assert.equal(manifest.regions?.[1]?.kind, "mixed");
  const overview = { ...inlineManifest, overview: { data: storedPart("overview"), scale: 32 } };
  assertBad(parseVoxelWorldManifest(overview), /server-only/);
  const storedOverview = assertManifest(parseVoxelWorldManifest(overview, { allowStoredRefs: true }));
  const opaqueOverview = toOpaqueVoxelWorldManifest(storedOverview);
  assert.equal(opaqueOverview.overview?.data.kind, "opaque");
  assertManifest(parseVoxelWorldManifest(opaqueOverview));
  assertBad(parseVoxelWorldManifest({ ...opaqueOverview, overview: { ...opaqueOverview.overview, scale: 1 } }), /overview scale/);
  assert.equal(
    voxelWorldPartUrl(
      { manifest, partBaseUrl: "/api/generations/gen_123/artifacts/viewer" },
      "mixed-0-data",
    ),
    "/api/generations/gen_123/artifacts/viewer?part=mixed-0-data",
  );
}

{
  const withStoredRef = {
    ...inlineManifest,
    exactBlockCount: 1,
    regions: [
      {
        kind: "mixed",
        key: "mixed-stored",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: 1, y: 1, z: 1 },
        blockCount: 1,
        format: "mbv4",
        coordinateSpace: "local",
        data: storedPart("mixed-stored-data"),
      },
    ],
  };
  assertBad(parseVoxelWorldManifest(withStoredRef), /server-only/);

  const storedManifest = assertManifest(parseVoxelWorldManifest(withStoredRef, { allowStoredRefs: true }));
  const delivered = toOpaqueVoxelWorldManifest(storedManifest);
  const region = delivered.regions?.[0];
  assert.equal(region?.kind, "mixed");
  if (region?.kind === "mixed") {
    assert.equal(region.data.kind, "opaque");
    assert.equal("bucket" in region.data, false);
    assert.equal("path" in region.data, false);
  }
}

{
  const localRefManifest = {
    ...inlineManifest,
    exactBlockCount: 1,
    regions: [
      {
        kind: "mixed",
        key: "mixed-local",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: 1, y: 1, z: 1 },
        blockCount: 1,
        format: "mbv4",
        coordinateSpace: "local",
        data: {
          kind: "localBlob",
          key: "mixed-local-data",
          encoding: "identity",
          byteSize: 16,
        },
      },
    ],
  };
  assertBad(parseVoxelWorldManifest(localRefManifest), /local-only/);
  assertManifest(parseVoxelWorldManifest(localRefManifest, { allowLocalBlobRefs: true }));
}

{
  const pagedManifest = assertManifest(parseVoxelWorldManifest({
    kind: "voxel_world",
    version: 1,
    gridSize: 8192,
    palette: "advanced",
    bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 128, y: 64, z: 64 } },
    exactBlockCount: 65,
    leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
    source: source(),
    regionPages: [
      {
        index: 0,
        bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 64, y: 64, z: 64 } },
        regionCount: 1,
        blockCount: 64,
        data: opaquePart("page-0"),
      },
      {
        index: 1,
        bounds: { origin: { x: 64, y: 0, z: 0 }, size: { x: 64, y: 64, z: 64 } },
        regionCount: 1,
        blockCount: 1,
        data: opaquePart("page-1", OTHER_SHA),
      },
    ],
  }));
  assert.equal(pagedManifest.regionPages?.length, 2);

  const page = assertPage(parseVoxelWorldRegionPage({
    kind: "voxel_world_region_page",
    version: 1,
    index: 0,
    bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 64, y: 64, z: 64 } },
    regionCount: 1,
    blockCount: 64,
    regions: [
      {
        kind: "uniform",
        key: "page-0-solid",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: 4, y: 4, z: 4 },
        type: "glass",
        blockCount: 64,
      },
    ],
  }, {
    gridSize: pagedManifest.gridSize,
    worldBounds: pagedManifest.bounds,
    pageRef: pagedManifest.regionPages?.[0],
  }));
  assert.equal(page.regionCount, 1);
}

{
  assertBad(
    parseVoxelWorldManifest({ ...inlineManifest, exactBlockCount: 262_155 }),
    /counts do not match/,
  );
  assertBad(
    parseVoxelWorldManifest({
      ...inlineManifest,
      exactBlockCount: 2,
      regions: [
        {
          kind: "mixed",
          key: "a",
          origin: { x: 0, y: 0, z: 0 },
          size: { x: 1, y: 1, z: 1 },
          blockCount: 1,
          format: "mbv4",
          coordinateSpace: "local",
          data: opaquePart("dup"),
        },
        {
          kind: "mixed",
          key: "b",
          origin: { x: 1, y: 0, z: 0 },
          size: { x: 1, y: 1, z: 1 },
          blockCount: 1,
          format: "mbv4",
          coordinateSpace: "local",
          data: opaquePart("dup", OTHER_SHA),
        },
      ],
    }),
    /Conflicting world part key/,
  );
  assertBad(
    parseVoxelWorldManifest({
      ...inlineManifest,
      exactBlockCount: 1,
      regions: [
        {
          kind: "mixed",
          key: "too-large",
          origin: { x: 0, y: 0, z: 0 },
          size: { x: 65, y: 1, z: 1 },
          blockCount: 1,
          format: "mbv4",
          coordinateSpace: "local",
          data: opaquePart("too-large-data"),
        },
      ],
    }),
    /mixed leaf size/,
  );
  assertBad(
    parseVoxelWorldManifest({
      kind: "voxel_world",
      version: 1,
      gridSize: 8192,
      palette: "simple",
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      exactBlockCount: 1,
      leafSize: VOXEL_WORLD_MIXED_LEAF_SIZE,
      source: source(),
      regionPages: Array.from({ length: VOXEL_WORLD_REGION_PAGE_REF_LIMIT + 1 }, (_, index) => ({
        index,
        bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
        regionCount: 1,
        blockCount: 1,
        data: opaquePart(`page-${index}`),
      })),
    }),
    /too many entries/,
  );
  assertBad(
    parseVoxelWorldRegionPage({
      kind: "voxel_world_region_page",
      version: 1,
      index: 0,
      bounds: { origin: { x: 0, y: 0, z: 0 }, size: { x: 8, y: 8, z: 8 } },
      regionCount: 1,
      blockCount: 1,
      regions: [
        {
          kind: "mixed",
          key: "outside",
          origin: { x: 9, y: 0, z: 0 },
          size: { x: 1, y: 1, z: 1 },
          blockCount: 1,
          format: "mbv4",
          coordinateSpace: "local",
          data: opaquePart("outside-data"),
        },
      ],
    }, { gridSize: 64 }),
    /outside the world bounds/,
  );
}

async function checkWorldDeliveryFetchCounts() {
  (globalThis as unknown as { prisma?: unknown }).prisma ??= {};
  const { customBuildWorldViewerResponse } = await import("../../../lib/custom-builds/worldDelivery");

  const manifestBytes = gzipJson(inlineManifest);
  const partBytes = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00);
  const manifestArtifact = {
    bucket: "unit",
    path: "manifest",
    contentType: "application/gzip",
    encoding: "gzip",
    sha256: sha256(manifestBytes),
    sourceBuildSha256: SHA,
  };
  const partArtifact = {
    bucket: "unit",
    path: "mixed",
    contentType: "application/gzip",
    encoding: "gzip",
    sha256: sha256(partBytes),
    sourceBuildSha256: OTHER_SHA,
  };
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  };
  process.env.SUPABASE_URL = "http://127.0.0.1:43219";
  process.env.SUPABASE_SECRET_KEY = "world-delivery-test-secret";
  const requestedPaths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer world-delivery-test-secret");
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace("/storage/v1/object/unit/", ""));
    requestedPaths.push(path);
    if (path === "manifest") return new Response(responseBytes(manifestBytes));
    if (path === "mixed") return new Response(responseBytes(partBytes));
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  try {
    const partKey = "mixed-0-data";
    let requestedSource: string | null = null;
    const response = await customBuildWorldViewerResponse({
      request: new Request(`http://localhost:3000/api/generations/cb/artifacts/viewer?part=${partKey}`),
      artifact: manifestArtifact,
      buildId: "cb",
      findPart: async (sourceBuildSha256, requestedKey) => {
        requestedSource = sourceBuildSha256;
        assert.equal(requestedKey, partKey);
        return partArtifact;
      },
      cacheControl: "private, no-store",
    });
    assert.equal(response.status, 200);
    assert.equal(requestedSource, SHA);
    assert.deepEqual(requestedPaths, ["mixed"]);

    requestedPaths.length = 0;
    requestedSource = null;
    const fallbackResponse = await customBuildWorldViewerResponse({
      request: new Request(`http://localhost:3000/api/generations/cb/artifacts/viewer?part=${partKey}`),
      artifact: { ...manifestArtifact, sourceBuildSha256: null },
      buildId: "cb",
      findPart: async (sourceBuildSha256, requestedKey) => {
        requestedSource = sourceBuildSha256;
        assert.equal(requestedKey, partKey);
        return partArtifact;
      },
      cacheControl: "private, no-store",
    });
    assert.equal(fallbackResponse.status, 200);
    assert.equal(requestedSource, inlineManifest.source.sha256);
    assert.deepEqual(requestedPaths, ["manifest", "mixed"]);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

checkWorldDeliveryFetchCounts()
  .then(() => {
    console.log("voxel world manifest checks passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
