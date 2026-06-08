import assert from "node:assert/strict";

const publicId = "cb_123456789012345678901234";
const buildSha256 = "a".repeat(64);

const baseCustomBuild = {
  id: "custom-build-row",
  publicId,
  status: "succeeded",
  currentStage: "complete",
  createdAt: new Date("2026-05-31T22:15:10.000Z"),
  startedAt: new Date("2026-05-31T22:15:14.000Z"),
  completedAt: new Date("2026-05-31T22:22:42.000Z"),
  promptText: "A compact tower",
  gridSize: 64,
  palette: "simple",
  modelKind: "catalog",
  modelKey: "gemini_3_5_flash",
  modelProvider: "gemini",
  modelId: "gemini-3.5-flash",
  modelDisplayName: "Gemini 3.5 Flash",
  blockCount: 256,
  generationTimeMs: 10_000,
  warnings: [],
  errorCode: null,
  errorMessage: null,
  errorRetryable: null,
  buildSha256,
};

const buildArtifact = {
  kind: "build_json",
  format: "json.gz",
  contentType: "application/gzip",
  byteSize: 1234,
  compressedByteSize: 456,
  sha256: buildSha256,
  sourceBuildSha256: buildSha256,
};

function exportArtifact(kind: "glb" | "stl" | "schem") {
  return {
    kind,
    format: kind,
    contentType: "application/octet-stream",
    byteSize: 123,
    compressedByteSize: null,
    sha256: buildSha256,
    sourceBuildSha256: buildSha256,
  };
}

let artifacts: unknown[] = [buildArtifact];
let jobs: unknown[] = [];

const fakePrisma = {
  customBuild: {
    findUnique: async () => ({
      ...baseCustomBuild,
      artifacts,
      jobs,
    }),
  },
};

(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

async function main() {
  const { GET } = await import("../../../app/api/custom-builds/[id]/route");

  jobs = [{ type: "export", status: "queued", payload: { format: "glb", sourceBuildSha256: buildSha256 } }];
  const activeExportResponse = await GET(
    new Request(`http://localhost/api/custom-builds/${publicId}`),
    { params: Promise.resolve({ id: publicId }) },
  );
  assert.equal(activeExportResponse.status, 200);
  assert.equal(activeExportResponse.headers.get("Cache-Control"), "no-store");

  jobs = [];
  artifacts = [buildArtifact, exportArtifact("glb"), exportArtifact("stl"), exportArtifact("schem")];
  const settledExportResponse = await GET(
    new Request(`http://localhost/api/custom-builds/${publicId}`),
    { params: Promise.resolve({ id: publicId }) },
  );
  assert.equal(settledExportResponse.status, 200);
  assert.equal(settledExportResponse.headers.get("Cache-Control"), "private, max-age=15");

  console.log("custom build status route cache checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
