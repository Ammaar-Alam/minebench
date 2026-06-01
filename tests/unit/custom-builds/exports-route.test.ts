import assert from "node:assert/strict";

const publicId = "cb_123456789012345678901234";
const customBuildId = "custom-build-row";
const buildSha256 = "a".repeat(64);
const previousCustomBuildsEnabled = process.env.CUSTOM_BUILDS_ENABLED;
let createdJobs = 0;
let statsUpdates = 0;
let findUniqueCalls = 0;

const baseCustomBuild = {
  id: customBuildId,
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

const runningExportJob = {
  type: "export",
  status: "running",
  payload: { format: "glb", sourceBuildSha256: buildSha256 },
  createdAt: new Date("2026-05-31T22:23:00.000Z"),
};

const fakePrisma = {
  customBuild: {
    findUnique: async () => {
      findUniqueCalls += 1;
      return {
        ...baseCustomBuild,
        artifacts: [],
        jobs: [],
      };
    },
    findUniqueOrThrow: async () => ({
      ...baseCustomBuild,
      artifacts: [],
      jobs: [runningExportJob],
    }),
  },
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
    callback({
      $queryRaw: async () => [{ id: customBuildId }],
      customBuildArtifact: {
        findFirst: async () => null,
      },
      customBuildJob: {
        findMany: async () => [runningExportJob],
        create: async () => {
          createdJobs += 1;
          return {};
        },
      },
      customBuildStatsDaily: {
        upsert: async () => {
          statsUpdates += 1;
          return {};
        },
      },
    }),
};

(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

async function main() {
  const { POST } = await import("../../../app/api/custom-builds/[id]/exports/route");

  process.env.CUSTOM_BUILDS_ENABLED = "0";
  const disabledResponse = await POST(
    new Request(`http://localhost/api/custom-builds/${publicId}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formats: ["glb"] }),
    }),
    { params: Promise.resolve({ id: publicId }) },
  );

  assert.equal(disabledResponse.status, 503);
  assert.equal(findUniqueCalls, 0, "disabled export requests should not load or mutate custom builds");
  assert.equal(createdJobs, 0);
  assert.equal(statsUpdates, 0);

  process.env.CUSTOM_BUILDS_ENABLED = "1";
  const response = await POST(
    new Request(`http://localhost/api/custom-builds/${publicId}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formats: ["glb"] }),
    }),
    { params: Promise.resolve({ id: publicId }) },
  );

  assert.equal(response.status, 202);
  assert.equal(createdJobs, 0);
  assert.equal(statsUpdates, 0);

  console.log("custom build export route checks passed");
}

main()
  .finally(() => {
    if (previousCustomBuildsEnabled === undefined) {
      delete process.env.CUSTOM_BUILDS_ENABLED;
    } else {
      process.env.CUSTOM_BUILDS_ENABLED = previousCustomBuildsEnabled;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
