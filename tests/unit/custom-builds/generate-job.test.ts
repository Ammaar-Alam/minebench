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

const customBuild = {
  id: customBuildId,
  publicId,
  status: "queued",
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
};

const updates: Array<{ data: Record<string, unknown> }> = [];
let eventSeq = 0;

const fakePrisma = {
  customBuild: {
    findUnique: async () => customBuild,
    update: async (args: { data: Record<string, unknown> }) => {
      updates.push(args);
      return { ...customBuild, ...args.data };
    },
  },
  customBuildArtifact: {
    upsert: async (args: { create: Record<string, unknown> }) => args.create,
  },
  customBuildJob: {
    create: async (args: { data: Record<string, unknown> }) => args.data,
  },
  customBuildStatsDaily: {
    upsert: async () => ({}),
  },
  customBuildSecret: {
    deleteMany: async () => ({ count: 0 }),
  },
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
    callback({
      $queryRaw: async () => [{ id: customBuildId }],
      customBuildEvent: {
        aggregate: async () => ({ _max: { seq: eventSeq } }),
        create: async (args: { data: { seq: number; type: string; data: Prisma.InputJsonValue } }) => {
          eventSeq = args.data.seq;
          return args.data;
        },
      },
    }),
};

(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

async function main() {
  const { runCustomBuildGenerateJob } = await import("../../../lib/custom-builds/generateJob");

  await runCustomBuildGenerateJob({
    id: "job-row",
    customBuildId,
    type: "generate",
    status: "running",
    attempts: 2,
    maxAttempts: 3,
    payload: {
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
