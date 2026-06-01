import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

const publicId = "cb_123456789012345678901234";
const customBuildId = "custom-build-row";
const previousStorageBucket = process.env.CUSTOM_BUILD_STORAGE_BUCKET;
const previousStorageDir = process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR;
const previousStubProvider = process.env.CUSTOM_BUILD_STUB_PROVIDER;

process.env.CUSTOM_BUILD_STORAGE_BUCKET = "__local_fs__";
process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = ".custom-build-storage/unit-generate-job";
process.env.CUSTOM_BUILD_STUB_PROVIDER = "1";

const queuedCustomBuild = {
  id: customBuildId,
  publicId,
  status: "queued",
  currentStage: "queued",
  completedAt: null as Date | null,
  promptText: "Build a stone marker",
  promptSha256: "prompt-sha",
  gridSize: 64,
  palette: "simple",
  modelKind: "catalog",
  modelKey: "gemini_3_5_flash",
  modelProvider: "gemini",
  modelId: "gemini-3.5-flash",
  modelDisplayName: "Gemini 3.5 Flash",
  customBaseUrl: null,
  openRouterModelId: "google/gemini-3.5-flash",
  preferOpenRouter: false,
  reasoning: null,
  startedAt: null,
  errorCode: "worker_failed",
  errorMessage: "first attempt failed",
  errorRetryable: true,
  buildSha256: null as string | null,
};
let currentCustomBuild = queuedCustomBuild;

const updates: Array<{ data: Record<string, unknown> }> = [];
const operations: Array<{ name: string; txId: number | null }> = [];
const artifactCreates: Array<Record<string, unknown>> = [];
let eventSeq = 0;
let txSeq = 0;
let failEventWrites = false;

const fakePrisma = {
  customBuild: {
    findUnique: async () => currentCustomBuild,
    update: async (args: { data: Record<string, unknown> }) => {
      updates.push(args);
      if (args.data.status === "succeeded") operations.push({ name: "customBuild.update.succeeded", txId: null });
      currentCustomBuild = { ...currentCustomBuild, ...args.data };
      return currentCustomBuild;
    },
  },
  customBuildArtifact: {
    upsert: async (args: { create: Record<string, unknown> }) => {
      artifactCreates.push(args.create);
      return args.create;
    },
  },
  customBuildJob: {
    create: async (args: { data: Record<string, unknown> }) => {
      operations.push({ name: "customBuildJob.create", txId: null });
      return args.data;
    },
  },
  customBuildStatsDaily: {
    upsert: async () => {
      operations.push({ name: "customBuildStatsDaily.upsert", txId: null });
      return {};
    },
  },
  customBuildSecret: {
    findUnique: async () => null,
    deleteMany: async () => {
      operations.push({ name: "customBuildSecret.deleteMany", txId: null });
      return { count: 0 };
    },
  },
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
    const txId = (txSeq += 1);
    return callback({
      $queryRaw: async () => [{ id: customBuildId }],
      customBuild: {
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args);
          if (args.data.status === "succeeded") operations.push({ name: "customBuild.update.succeeded", txId });
          currentCustomBuild = { ...currentCustomBuild, ...args.data };
          return currentCustomBuild;
        },
      },
      customBuildJob: {
        create: async (args: { data: Record<string, unknown> }) => {
          operations.push({ name: "customBuildJob.create", txId });
          return args.data;
        },
      },
      customBuildStatsDaily: {
        upsert: async () => {
          operations.push({ name: "customBuildStatsDaily.upsert", txId });
          return {};
        },
      },
      customBuildSecret: {
        deleteMany: async () => {
          operations.push({ name: "customBuildSecret.deleteMany", txId });
          return { count: 0 };
        },
      },
      customBuildEvent: {
        aggregate: async () => ({ _max: { seq: eventSeq } }),
        create: async (args: { data: { seq: number; type: string; data: Prisma.InputJsonValue } }) => {
          if (failEventWrites) throw new Error("event insert failed");
          eventSeq = args.data.seq;
          return args.data;
        },
      },
    });
  },
};

(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

async function flushAsyncEvents() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

async function main() {
  const {
    runCustomBuildGenerateJob,
    isTerminalCustomBuildGenerateError,
    validateGeneratedBuildForArtifacts,
  } = await import("../../../lib/custom-builds/generateJob");
  const { gzipBytes, jsonBytes, sha256Hex } = await import("../../../lib/custom-builds/artifacts");

  assert.equal(
    isTerminalCustomBuildGenerateError("OpenAI error 401: invalid_api_key"),
    true,
  );
  assert.equal(
    isTerminalCustomBuildGenerateError("Gemini error 400: structured output is not supported"),
    true,
  );
  assert.equal(
    isTerminalCustomBuildGenerateError("Gemini request timed out"),
    false,
  );
  assert.equal(
    isTerminalCustomBuildGenerateError("custom_build_artifact_persistence_failed: storage unavailable"),
    true,
  );

  const expandedPrimitiveBuild = validateGeneratedBuildForArtifacts(
    {
      version: "1.0",
      blocks: [],
      boxes: [{ x1: 1, y1: 1, z1: 1, x2: 2, y2: 2, z2: 2, type: "stone" }],
      lines: [{ from: { x: 4, y: 1, z: 1 }, to: { x: 6, y: 1, z: 1 }, type: "oak_planks" }],
    },
    queuedCustomBuild as never,
  );
  assert.equal(expandedPrimitiveBuild.build.blocks.length, 11);
  assert.equal(expandedPrimitiveBuild.build.boxes, undefined);
  assert.equal(expandedPrimitiveBuild.build.lines, undefined);

  await runCustomBuildGenerateJob({
    id: "job-row",
    customBuildId,
    type: "generate",
    status: "running",
    attempts: 2,
    maxAttempts: 3,
    payload: {
      requestedExports: ["glb"],
      stubBuild: {
        version: "1.0",
        blocks: [{ x: 1, y: 1, z: 1, type: "stone" }],
      },
    },
  } as never);

  const successUpdate = updates.find((update) => update.data.status === "succeeded");
  assert.ok(successUpdate, "generate job should persist a successful retry");
  assert.equal(successUpdate.data.errorCode, null);
  assert.equal(successUpdate.data.errorMessage, null);
  assert.equal(successUpdate.data.errorRetryable, null);
  const successTxId = operations.find((op) => op.name === "customBuild.update.succeeded")?.txId;
  assert.notEqual(successTxId, null, "success update should run inside the bookkeeping transaction");
  assert.equal(operations.find((op) => op.name === "customBuildJob.create")?.txId, successTxId);
  assert.equal(operations.find((op) => op.name === "customBuildStatsDaily.upsert")?.txId, successTxId);
  assert.equal(operations.find((op) => op.name === "customBuildSecret.deleteMany")?.txId, successTxId);
  const expectedFullBytes = jsonBytes({
    version: "1.0",
    blocks: [{ x: 1, y: 1, z: 1, type: "stone" }],
  });
  const expectedFullSourceSha = sha256Hex(expectedFullBytes);
  const expectedFullArtifactSha = sha256Hex(gzipBytes(expectedFullBytes));
  const buildJsonArtifact = artifactCreates.find((artifact) => artifact.kind === "build_json");
  const previewJsonArtifact = artifactCreates.find((artifact) => artifact.kind === "preview_json");
  assert.ok(buildJsonArtifact, "generate job should record the full JSON artifact");
  assert.ok(previewJsonArtifact, "generate job should record the preview JSON artifact");
  assert.equal(buildJsonArtifact.sha256, expectedFullArtifactSha);
  assert.equal(buildJsonArtifact.sourceBuildSha256, expectedFullSourceSha);
  assert.equal(previewJsonArtifact.sha256, expectedFullArtifactSha);
  assert.equal(previewJsonArtifact.sourceBuildSha256, expectedFullSourceSha);

  updates.length = 0;
  operations.length = 0;
  artifactCreates.length = 0;
  eventSeq = 0;
  txSeq = 0;
  currentCustomBuild = queuedCustomBuild;
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    failEventWrites = true;
    await runCustomBuildGenerateJob({
      id: "event-failure-job-row",
      customBuildId,
      type: "generate",
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      payload: {
        requestedExports: ["glb"],
        stubBuild: {
          version: "1.0",
          blocks: [{ x: 2, y: 1, z: 1, type: "stone" }],
        },
      },
    } as never);
    await flushAsyncEvents();
  } finally {
    failEventWrites = false;
    console.warn = previousWarn;
  }

  assert.ok(
    updates.find((update) => update.data.status === "succeeded"),
    "event write failures should not prevent a successful generate job",
  );
  assert.ok(
    operations.some((op) => op.name === "customBuildSecret.deleteMany"),
    "event write failures should not skip success bookkeeping",
  );

  updates.length = 0;
  operations.length = 0;
  artifactCreates.length = 0;
  eventSeq = 0;
  txSeq = 0;
  currentCustomBuild = queuedCustomBuild;
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = "package.json";
  await assert.rejects(
    runCustomBuildGenerateJob({
      id: "artifact-failure-job-row",
      customBuildId,
      type: "generate",
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      payload: {
        stubBuild: {
          version: "1.0",
          blocks: [{ x: 3, y: 1, z: 1, type: "stone" }],
        },
      },
    } as never),
    /custom_build_artifact_persistence_failed/,
  );
  assert.equal(
    updates.some((update) => update.data.status === "queued"),
    false,
    "artifact persistence failures should not requeue paid generation",
  );
  const artifactFailureUpdate = updates.find((update) => update.data.status === "failed");
  assert.ok(artifactFailureUpdate, "artifact persistence failures should fail the custom build");
  assert.equal(artifactFailureUpdate.data.errorCode, "artifact_persistence_failed");
  assert.equal(artifactFailureUpdate.data.errorRetryable, false);
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = ".custom-build-storage/unit-generate-job";

  updates.length = 0;
  operations.length = 0;
  eventSeq = 0;
  txSeq = 0;
  currentCustomBuild = {
    ...queuedCustomBuild,
    status: "succeeded",
    currentStage: "complete",
    completedAt: new Date("2026-05-31T22:22:42.000Z"),
    buildSha256: "a".repeat(64),
  };
  await runCustomBuildGenerateJob({
    id: "stale-job-row",
    customBuildId,
    type: "generate",
    status: "running",
    attempts: 3,
    maxAttempts: 3,
    payload: {},
  } as never);

  assert.equal(updates.length, 0, "succeeded custom builds should not be rerun or overwritten");

  console.log("custom build generate job retry checks passed");
}

main()
  .finally(() => {
    if (previousStorageBucket === undefined) {
      delete process.env.CUSTOM_BUILD_STORAGE_BUCKET;
    } else {
      process.env.CUSTOM_BUILD_STORAGE_BUCKET = previousStorageBucket;
    }
    if (previousStorageDir === undefined) {
      delete process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR;
    } else {
      process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = previousStorageDir;
    }
    if (previousStubProvider === undefined) {
      delete process.env.CUSTOM_BUILD_STUB_PROVIDER;
    } else {
      process.env.CUSTOM_BUILD_STUB_PROVIDER = previousStubProvider;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
