import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";

const generateJobSource = readFileSync("lib/custom-builds/generateJob.ts", "utf8");

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
  warnings: null as Prisma.JsonValue | null,
  generationTimeMs: null as number | null,
};
let currentCustomBuild = queuedCustomBuild;

const updates: Array<{ data: Record<string, unknown> }> = [];
const operations: Array<{ name: string; txId: number | null }> = [];
const artifactCreates: Array<Record<string, unknown>> = [];
let eventSeq = 0;
let txSeq = 0;
let failEventWrites = false;
let failSuccessBookkeeping = false;
let cancelDuringArtifactRecord = false;
let failArtifactKind: string | null = null;

const fakePrisma = {
  customBuild: {
    findUnique: async () => currentCustomBuild,
    update: async (args: { data: Record<string, unknown> }) => {
      updates.push(args);
      if (args.data.status === "succeeded") operations.push({ name: "customBuild.update.succeeded", txId: null });
      currentCustomBuild = { ...currentCustomBuild, ...args.data };
      return currentCustomBuild;
    },
    updateMany: async (args: { data: Record<string, unknown> }) => {
      if (cancelDuringArtifactRecord && "storedByteSize" in args.data) {
        currentCustomBuild = { ...currentCustomBuild, status: "canceled" };
        return { count: 0 };
      }
      if (cancelDuringArtifactRecord && args.data.status === "failed") {
        return { count: 0 };
      }
      updates.push(args);
      currentCustomBuild = { ...currentCustomBuild, ...args.data };
      return { count: 1 };
    },
  },
  customBuildArtifact: {
    findFirst: async () => artifactCreates.find((artifact) => artifact.kind === "build_json") ?? null,
    findUnique: async () => null,
    upsert: async (args: { create: Record<string, unknown> }) => {
      if (args.create.kind === failArtifactKind) throw new Error("artifact bookkeeping unavailable");
      const index = artifactCreates.findIndex((artifact) =>
        artifact.kind === args.create.kind &&
        artifact.sourceBuildSha256 === args.create.sourceBuildSha256
      );
      if (index >= 0) artifactCreates[index] = args.create;
      else artifactCreates.push(args.create);
      return args.create;
    },
    aggregate: async () => ({
      _sum: {
        storedByteSize: artifactCreates.reduce(
          (sum, artifact) => sum + Number(artifact.storedByteSize ?? 0),
          0,
        ),
      },
    }),
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
          if (args.data.status === "succeeded" && failSuccessBookkeeping) {
            throw new Error("bookkeeping update failed");
          }
          updates.push(args);
          if (args.data.status === "succeeded") operations.push({ name: "customBuild.update.succeeded", txId });
          currentCustomBuild = { ...currentCustomBuild, ...args.data };
          return currentCustomBuild;
        },
        updateMany: async (args: { data: Record<string, unknown> }) => {
          if (cancelDuringArtifactRecord && args.data.status === "failed") {
            return { count: 0 };
          }
          if (args.data.status === "succeeded" && failSuccessBookkeeping) {
            throw new Error("bookkeeping update failed");
          }
          updates.push(args);
          if (args.data.status === "succeeded") operations.push({ name: "customBuild.update.succeeded", txId });
          currentCustomBuild = { ...currentCustomBuild, ...args.data };
          return { count: 1 };
        },
      },
      customBuildArtifact: {
        aggregate: async () => ({
          _sum: {
            storedByteSize: artifactCreates.reduce(
              (sum, artifact) => sum + Number(artifact.storedByteSize ?? 0),
              0,
            ),
          },
        }),
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
    customBuildProviderSignal,
    isTerminalCustomBuildGenerateError,
    validateGeneratedBuildForArtifacts,
  } = await import("../../../lib/custom-builds/generateJob");
  const { safeCustomBuildRetryReason } = await import("../../../lib/custom-builds/sanitize");
  const { jsonBytes, sha256Hex } = await import("../../../lib/custom-builds/artifacts");
  const { CustomBuildLeaseLostError } = await import("../../../lib/custom-builds/lease");

  assert.ok(
    generateJobSource.includes("buildGalleryPreviewSvg(canonicalBuild)") &&
      generateJobSource.includes("blockCount: canonicalBuild.blocks.length"),
    "static thumbnails should derive from the canonical build rather than the sampled viewer preview",
  );
  assert.ok(
    generateJobSource.includes("writeCanonicalBuildArtifact(canonicalBuild)") &&
      !generateJobSource.includes("jsonBytes(canonicalBuild)") &&
      !generateJobSource.includes("gzipBytes(fullBytes)"),
    "canonical artifacts should be serialized and compressed without whole-build buffers",
  );
  assert.ok(
    generateJobSource.includes("const CUSTOM_BUILD_MODEL_MAX_ATTEMPTS = 2") &&
      generateJobSource.includes("maxAttempts: CUSTOM_BUILD_MODEL_MAX_ATTEMPTS"),
    "durable generations should make at most one automatic repair request",
  );
  assert.ok(
    generateJobSource.includes("const CUSTOM_BUILD_PROVIDER_TIMEOUT_MS = 90 * 60 * 1000") &&
      generateJobSource.includes("customBuildProviderSignal(opts.signal)") &&
      !generateJobSource.includes("if (!manuallyRetryable)"),
    "provider waits should have a 90-minute deadline and terminal failures should always delete credentials",
  );

  const providerSignal = customBuildProviderSignal(undefined, 5);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(providerSignal.aborted, true);
  assert.equal(
    safeCustomBuildRetryReason('Gemini error 429: {"private":"provider body"}'),
    'Gemini error 429: {"private":"provider body"}',
  );
  assert.equal(
    safeCustomBuildRetryReason('[{"code":"invalid_type","message":"Required"}]'),
    '[{"code":"invalid_type","message":"Required"}]',
  );
  assert.equal(
    safeCustomBuildRetryReason('Bearer sk-1234567890abcdef'),
    'Bearer [redacted]',
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
  assert.equal(
    isTerminalCustomBuildGenerateError("custom_build_artifact_persistence_failed: storage unavailable"),
    true,
  );
  assert.equal(
    isTerminalCustomBuildGenerateError("custom_build_artifact_bookkeeping_failed: db unavailable"),
    false,
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
  assert.equal(operations.find((op) => op.name === "customBuildStatsDaily.upsert")?.txId, successTxId);
  assert.equal(operations.find((op) => op.name === "customBuildSecret.deleteMany")?.txId, successTxId);
  const expectedFullBytes = jsonBytes({
    version: "1.0",
    blocks: [{ x: 1, y: 1, z: 1, type: "stone" }],
  });
  const expectedFullSourceSha = sha256Hex(expectedFullBytes);
  const buildJsonArtifact = artifactCreates.find((artifact) => artifact.kind === "build_json");
  const previewArtifact = artifactCreates.find((artifact) => artifact.kind === "preview_mbv4");
  const viewerArtifact = artifactCreates.find((artifact) => artifact.kind === "viewer_mbv4");
  const thumbnailArtifact = artifactCreates.find((artifact) => artifact.kind === "preview_svg");
  assert.ok(buildJsonArtifact, "generate job should record the full JSON artifact");
  assert.ok(previewArtifact, "generate job should record the binary preview artifact");
  assert.ok(viewerArtifact, "generate job should record the full viewer artifact");
  assert.ok(thumbnailArtifact, "generate job should record the static preview artifact");
  assert.match(String(buildJsonArtifact.sha256), /^[a-f0-9]{64}$/);
  assert.equal(buildJsonArtifact.sourceBuildSha256, expectedFullSourceSha);
  assert.equal(previewArtifact.sourceBuildSha256, expectedFullSourceSha);
  assert.equal(viewerArtifact.sourceBuildSha256, expectedFullSourceSha);
  assert.equal(thumbnailArtifact.sourceBuildSha256, expectedFullSourceSha);

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
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = "../package.json";
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
    /artifact_persistence_failed/,
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
  artifactCreates.length = 0;
  eventSeq = 0;
  txSeq = 0;
  currentCustomBuild = queuedCustomBuild;
  failArtifactKind = "preview_mbv4";
  try {
    await assert.rejects(
      runCustomBuildGenerateJob({
        id: "partial-artifact-failure-job-row",
        customBuildId,
        type: "generate",
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        payload: {
          stubBuild: {
            version: "1.0",
            blocks: [{ x: 3, y: 2, z: 1, type: "stone" }],
          },
        },
      } as never),
      /artifact_persistence_failed/,
    );
  } finally {
    failArtifactKind = null;
  }
  assert.equal(
    artifactCreates.some((artifact) => artifact.kind === "build_json"),
    true,
    "the partial-failure fixture should record the canonical artifact first",
  );
  assert.equal(
    updates.some((update) => update.data.deletionPendingAt instanceof Date),
    true,
    "terminal partial artifact failures should schedule recorded objects for cleanup",
  );

  updates.length = 0;
  operations.length = 0;
  artifactCreates.length = 0;
  eventSeq = 0;
  txSeq = 0;
  currentCustomBuild = queuedCustomBuild;
  failSuccessBookkeeping = true;
  try {
    await assert.rejects(
      runCustomBuildGenerateJob({
        id: "bookkeeping-failure-job-row",
        customBuildId,
        type: "generate",
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        payload: {
          requestedExports: ["glb"],
          stubBuild: {
            version: "1.0",
            blocks: [{ x: 4, y: 1, z: 1, type: "stone" }],
          },
        },
      } as never),
      /generation_retryable/,
    );
  } finally {
    failSuccessBookkeeping = false;
  }
  assert.equal(
    artifactCreates.filter((artifact) =>
      ["build_json", "preview_mbv4", "viewer_mbv4", "preview_svg"].includes(String(artifact.kind)),
    ).length,
    4,
    "bookkeeping failure regression should happen after all Gallery artifacts are recorded",
  );
  assert.equal(
    updates.some((update) => update.data.status === "queued"),
    true,
    "post-artifact bookkeeping failures should retry finalization",
  );
  assert.equal(
    updates.some((update) => update.data.status === "failed"),
    false,
    "stored canonical results should not fail before recovery is attempted",
  );
  const recoveredSourceSha = artifactCreates.find((artifact) => artifact.kind === "build_json")
    ?.sourceBuildSha256;
  updates.length = 0;
  operations.length = 0;
  await runCustomBuildGenerateJob({
    id: "bookkeeping-recovery-job-row",
    customBuildId,
    type: "generate",
    status: "running",
    attempts: 2,
    maxAttempts: 3,
    payload: {
      stubBuild: {
        version: "1.0",
        blocks: [{ x: 63, y: 1, z: 1, type: "gold_block" }],
      },
    },
  } as never);
  assert.ok(
    updates.some((update) => update.data.status === "succeeded"),
    "a retry should finalize the verified canonical artifact",
  );
  assert.equal(
    artifactCreates.find((artifact) => artifact.kind === "build_json")?.sourceBuildSha256,
    recoveredSourceSha,
    "recovery should not invoke the provider or replace its stored result",
  );

  updates.length = 0;
  operations.length = 0;
  currentCustomBuild = queuedCustomBuild;
  await assert.rejects(
    runCustomBuildGenerateJob({
      id: "bookkeeping-recovery-lease-loss-job-row",
      customBuildId,
      type: "generate",
      status: "running",
      attempts: 2,
      maxAttempts: 3,
      payload: {},
    } as never, {
      acquireBuildProcessing: async () => {
        throw new CustomBuildLeaseLostError();
      },
    }),
    /lease is no longer owned/,
  );
  assert.equal(
    updates.some((update) => update.data.status === "queued" || update.data.status === "failed"),
    false,
    "artifact recovery should not mutate a build after its lease is lost",
  );

  updates.length = 0;
  operations.length = 0;
  artifactCreates.length = 0;
  eventSeq = 0;
  txSeq = 0;
  currentCustomBuild = queuedCustomBuild;
  cancelDuringArtifactRecord = true;
  try {
    await assert.rejects(
      runCustomBuildGenerateJob({
        id: "artifact-cancel-race-job-row",
        customBuildId,
        type: "generate",
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        payload: {
          stubBuild: {
            version: "1.0",
            blocks: [{ x: 5, y: 1, z: 1, type: "stone" }],
          },
        },
      } as never),
      /lease is no longer owned/,
    );
  } finally {
    cancelDuringArtifactRecord = false;
  }
  assert.equal(currentCustomBuild.status, "canceled");
  assert.ok(
    (currentCustomBuild as typeof queuedCustomBuild & { deletionPendingAt?: Date })
      .deletionPendingAt instanceof Date,
  );
  assert.equal(
    updates.some((update) => update.data.status === "failed"),
    false,
    "artifact persistence should not overwrite a racing cancellation",
  );

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
