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
let eventSeq = 0;
let txSeq = 0;

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
    upsert: async (args: { create: Record<string, unknown> }) => args.create,
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
          eventSeq = args.data.seq;
          return args.data;
        },
      },
    });
  },
};

(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

async function main() {
  const { runCustomBuildGenerateJob, isTerminalCustomBuildGenerateError } = await import(
    "../../../lib/custom-builds/generateJob"
  );

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

  updates.length = 0;
  operations.length = 0;
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
