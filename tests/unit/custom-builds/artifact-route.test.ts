import assert from "node:assert/strict";

const publicId = "cb_123456789012345678901234";
const buildSha256 = "a".repeat(64);
const previewSha256 = "b".repeat(64);
const previousSupabaseUrl = process.env.SUPABASE_URL;
const previousSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const previousFetch = globalThis.fetch;

process.env.SUPABASE_URL = "https://storage.example";
process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-service-role";

const artifactBytes = new Uint8Array([1, 2, 3, 4]);
const fetchCalls: Array<{ url: string; method: string }> = [];

const fakePrisma = {
  customBuild: {
    findUnique: async () => ({
      id: "custom-build-row",
      publicId,
      status: "succeeded",
      buildSha256,
      artifacts: [
        {
          kind: "preview_json",
          bucket: "builds",
          path: `custom-builds/v1/${publicId}/preview/preview-${previewSha256}.json.gz`,
          contentType: "application/gzip",
          byteSize: 12,
          compressedByteSize: artifactBytes.byteLength,
          sha256: previewSha256,
          sourceBuildSha256: buildSha256,
        },
      ],
    }),
  },
};

(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  fetchCalls.push({ url, method });
  if (url.includes("/storage/v1/object/sign/")) {
    return Response.json({ signedURL: "/object/signature" });
  }
  if (url.includes("/storage/v1/object/builds/")) {
    return new Response(artifactBytes);
  }
  return new Response("unexpected request", { status: 500 });
};

async function main() {
  const { GET } = await import("../../../app/api/custom-builds/[id]/artifacts/[format]/route");

  const redirectResponse = await GET(
    new Request(`http://localhost/api/custom-builds/${publicId}/artifacts/preview-json`),
    { params: Promise.resolve({ id: publicId, format: "preview-json" }) },
  );
  assert.equal(redirectResponse.status, 307);
  assert.equal(redirectResponse.headers.get("Location"), "https://storage.example/storage/v1/object/signature");

  fetchCalls.length = 0;
  const proxyResponse = await GET(
    new Request(`http://localhost/api/custom-builds/${publicId}/artifacts/preview-json?redirect=0`),
    { params: Promise.resolve({ id: publicId, format: "preview-json" }) },
  );
  assert.equal(proxyResponse.status, 200);
  assert.equal(proxyResponse.headers.get("Content-Type"), "application/gzip");
  assert.deepEqual(new Uint8Array(await proxyResponse.arrayBuffer()), artifactBytes);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.method, "GET");
  assert.ok(
    fetchCalls[0]?.url.includes("/storage/v1/object/builds/"),
    "redirect=0 should download the artifact through the same-origin route",
  );

  console.log("custom build artifact route checks passed");
}

main()
  .finally(() => {
    if (previousSupabaseUrl === undefined) {
      delete process.env.SUPABASE_URL;
    } else {
      process.env.SUPABASE_URL = previousSupabaseUrl;
    }
    if (previousSupabaseKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = previousSupabaseKey;
    }
    globalThis.fetch = previousFetch;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
