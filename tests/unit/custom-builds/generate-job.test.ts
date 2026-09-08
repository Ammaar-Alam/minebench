import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";

const generateJobSource = readFileSync("lib/custom-builds/generateJob.ts", "utf8");
const providerSignalSource = readFileSync("lib/generation-worker/providerSignal.ts", "utf8");

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
  const { customBuildWorldViewerResponse } = await import("../../../lib/custom-builds/worldDelivery");
  const { voxelWorldPartSourceSha256 } = await import("../../../lib/custom-builds/worldArtifacts");
  const { safeCustomBuildRetryReason } = await import("../../../lib/custom-builds/sanitize");
  const { decodeAndVerifyCustomBuildArtifactText, gzipBytes, jsonBytes, sha256Hex, uploadAndRecordCustomBuildArtifact } = await import("../../../lib/custom-builds/artifacts");
  const { downloadCustomBuildArtifactBytes } = await import("../../../lib/custom-builds/storage");
  const { CustomBuildLeaseLostError } = await import("../../../lib/custom-builds/lease");

  assert.ok(
    generateJobSource.includes("buildGalleryPreviewSvg(useWorldArtifacts ? preview : canonicalBuild)") &&
      generateJobSource.includes("blockCount: canonicalBlockCount"),
    "static thumbnails should derive from the canonical build, except compact worlds which use the world preview",
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
    providerSignalSource.includes("const GENERATION_PROVIDER_TIMEOUT_MS = 90 * 60 * 1000") &&
      generateJobSource.includes("return generationProviderSignal(signal, timeoutMs)") &&
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
    safeCustomBuildRetryReason('Custom error: {"api_key":"supersecretcredential"}'),
    'Custom error: {"api_key":"[redacted]"}',
  );
  assert.equal(
    safeCustomBuildRetryReason('{"apiKey": "my-secret-key", "status": 401}'),
    '{"apiKey": "[redacted]", "status": 401}',
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
  const importedCompletedAt = new Date("2026-08-31T04:35:00.445Z");
  await runCustomBuildGenerateJob({
    id: "imported-job-row",
    customBuildId,
    type: "generate",
    status: "running",
    attempts: 1,
    maxAttempts: 1,
    payload: {},
  } as never, {
    importedBuild: {
      build: {
        version: "1.0",
        blocks: [{ x: 8, y: 1, z: 3, type: "bricks" }],
      },
      warnings: [],
      blockCount: 1,
      generationTimeMs: 178_462,
      completedAt: importedCompletedAt,
      sourceArtifactSha256: "f".repeat(64),
    },
  });
  const importedSuccess = updates.find((update) => update.data.status === "succeeded");
  assert.ok(importedSuccess, "imports should finalize as successful saved generations");
  assert.equal(importedSuccess.data.completedAt, importedCompletedAt);
  assert.equal(importedSuccess.data.generationTimeMs, 178_462);
  assert.deepEqual(importedSuccess.data.metrics, {
    blockCount: 1,
    generationTimeMs: 178_462,
    warnings: [],
    sourceArtifactSha256: "f".repeat(64),
  });
  assert.deepEqual(
    artifactCreates.map((artifact) => artifact.kind).sort(),
    ["build_json", "preview_mbv4", "preview_svg", "viewer_mbv4"],
  );

  updates.length = 0;
  operations.length = 0;
  artifactCreates.length = 0;
  eventSeq = 0;
  txSeq = 0;
  currentCustomBuild = {
    ...queuedCustomBuild,
    gridSize: 8192,
    promptText: "Build a solid stone world",
  };
  await runCustomBuildGenerateJob({
    id: "world-cube-job-row",
    customBuildId,
    type: "generate",
    status: "running",
    attempts: 1,
    maxAttempts: 1,
    payload: {
      stubBuild: {
        version: "1.0",
        boxes: [{ x1: 0, y1: 0, z1: 0, x2: 8191, y2: 8191, z2: 8191, type: "stone" }],
        blocks: [],
      },
    },
  } as never);
  const cubeSuccess = updates.find((update) => update.data.status === "succeeded");
  assert.ok(cubeSuccess, "8192 saved jobs should complete from compact source");
  assert.equal(cubeSuccess.data.blockCount, 8192 ** 3);
  assert.equal(cubeSuccess.data.previewBlockCount, 3000);
  assert.ok(
    Number(cubeSuccess.data.buildByteSize) < 400,
    "compact source should be stored instead of expanded JSON",
  );
  assert.deepEqual(
    artifactCreates.map((artifact) => artifact.kind).sort(),
    ["build_json", "preview_mbv4", "preview_svg", "viewer_world"],
  );
  const cubeManifestArtifact = artifactCreates.find((artifact) => artifact.kind === "viewer_world");
  assert.equal(cubeManifestArtifact?.blockCount, 8192 ** 3);

  updates.length = 0;
  operations.length = 0;
  artifactCreates.length = 0;
  eventSeq = 0;
  txSeq = 0;
  currentCustomBuild = {
    ...queuedCustomBuild,
    gridSize: 8192,
    promptText: "Build repeated local mixed lines",
  };
  await runCustomBuildGenerateJob({
    id: "world-mixed-job-row",
    customBuildId,
    type: "generate",
    status: "running",
    attempts: 1,
    maxAttempts: 1,
    payload: {
      stubBuild: {
        version: "1.0",
        blocks: Array.from({ length: 128 }, (_, x) => ({
          x,
          y: 0,
          z: 0,
          type: x % 2 === 0 ? "stone" : "cobblestone",
        })),
      },
    },
  } as never);
  const mixedManifestArtifact = artifactCreates.find((artifact) => artifact.kind === "viewer_world");
  const mixedPartArtifact = artifactCreates.find((artifact) => artifact.kind === "world_part");
  assert.ok(mixedManifestArtifact, "mixed worlds should record a viewer manifest");
  assert.ok(mixedPartArtifact, "mixed worlds should record authorized part data");
  assert.equal(
    artifactCreates.filter((artifact) => artifact.kind === "world_part" && (artifact.exportStats as { worldPartKey?: string })?.worldPartKey?.startsWith("mixed-")).length,
    1,
    "identical mixed region payloads should share one stored part",
  );

  const viewerResponse = await customBuildWorldViewerResponse({
    request: new Request(`http://localhost:3000/api/generations/${publicId}/artifacts/viewer`),
    artifact: mixedManifestArtifact as never,
    buildId: publicId,
    findPart: async () => null,
    cacheControl: "private, no-store",
  });
  assert.equal(viewerResponse.status, 200);
  const viewerBody = await viewerResponse.json() as {
    voxelBuild: {
      world: {
        manifest: {
          exactBlockCount: number;
          regions?: Array<{ kind: string; data?: { key: string; kind: string } }>;
        };
        partBaseUrl: string;
      };
    };
  };
  assert.equal(viewerBody.voxelBuild.world.manifest.exactBlockCount, 128);
  assert.equal(viewerBody.voxelBuild.world.partBaseUrl, `/api/generations/${publicId}/artifacts/viewer`);
  const partKey = viewerBody.voxelBuild.world.manifest.regions?.[0]?.data?.key;
  assert.equal(viewerBody.voxelBuild.world.manifest.regions?.[0]?.data?.kind, "opaque");
  assert.ok(partKey, "delivered manifests should expose opaque part keys");

  let requestedPart: { sourceBuildSha256: string; partKey: string } | null = null;
  const partResponse = await customBuildWorldViewerResponse({
    request: new Request(`http://localhost:3000/api/generations/${publicId}/artifacts/viewer?part=${partKey}`),
    artifact: mixedManifestArtifact as never,
    buildId: publicId,
    findPart: async (sourceBuildSha256, requestedKey) => {
      requestedPart = { sourceBuildSha256, partKey: requestedKey };
      return artifactCreates.find((artifact) =>
        artifact.kind === "world_part" &&
        artifact.sourceBuildSha256 === voxelWorldPartSourceSha256(sourceBuildSha256, requestedKey)
      ) as never ?? null;
    },
    cacheControl: "private, no-store",
  });
  assert.equal(partResponse.status, 200);
  assert.deepEqual(requestedPart, {
    sourceBuildSha256: mixedManifestArtifact.sourceBuildSha256,
    partKey,
  });
  const partBytes = new Uint8Array(await partResponse.arrayBuffer());
  assert.equal(partBytes[0], 0x1f, "world parts should remain gzip encoded for client-side inflation");
  assert.equal(partBytes[1], 0x8b);

  const originalRecoveryArtifact = artifactCreates.find((artifact) => artifact.kind === "build_json");
  assert.ok(originalRecoveryArtifact);
  const originalRecoveryBytes = await downloadCustomBuildArtifactBytes(originalRecoveryArtifact as never);
  const recoveryText = `\n${decodeAndVerifyCustomBuildArtifactText({ bytes: originalRecoveryBytes, encoding: "gzip" })}`;
  const recoverySourceBytes = new TextEncoder().encode(recoveryText);
  const recoveryBytes = gzipBytes(recoverySourceBytes);
  const recoveryArtifact = await uploadAndRecordCustomBuildArtifact({
    customBuildId, publicId, kind: "build_json", bytes: recoveryBytes,
    sourceBuildSha256: sha256Hex(recoverySourceBytes), uncompressedByteSize: recoverySourceBytes.length,
    blockCount: 128, encoding: "gzip",
  });
  const originalFetch = globalThis.fetch;
  const originalParse = JSON.parse;
  const recoveryEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = "http://127.0.0.1:43198";
  process.env.SUPABASE_SECRET_KEY = "unit-stream-recovery-secret";
  JSON.parse = (text, reviver) => {
    assert.notEqual(text, recoveryText, "recovery must parse source entries without a whole-build JSON string");
    return originalParse(text, reviver);
  };
  try {
    for (const mode of ["local", "gzip", "decoded", "stored-sha", "source-sha", "block-count", "stream-error", "aborted"] as const) {
      updates.length = 0;
      operations.length = 0;
      currentCustomBuild = { ...queuedCustomBuild, gridSize: 8192, generationTimeMs: 1234 };
      const artifact = {
        ...recoveryArtifact,
        bucket: mode === "local" ? "__local_fs__" : "recovery-fixture",
        ...(mode === "stored-sha" ? { sha256: "0".repeat(64) } : {}),
        ...(mode === "source-sha" ? { sourceBuildSha256: "0".repeat(64) } : {}),
        ...(mode === "block-count" ? { blockCount: 129 } : {}),
      };
      artifactCreates.splice(0, artifactCreates.length, artifact);
      const abort = new AbortController();
      let fetches = 0;
      let canceled = false;
      globalThis.fetch = async (input, init) => {
        fetches += 1;
        assert.equal(String(input), `http://127.0.0.1:43198/storage/v1/object/recovery-fixture/${recoveryArtifact.path}`);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer unit-stream-recovery-secret");
        assert.equal(init?.signal, abort.signal);
        const bytes = mode === "decoded" ? recoverySourceBytes : recoveryBytes;
        let offset = 0;
        const response = new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= 12 && mode === "stream-error") {
              controller.error(new Error("stream download interrupted"));
              return;
            }
            if (offset >= 12 && mode === "aborted") {
              abort.abort(new CustomBuildLeaseLostError());
            }
            if (offset >= bytes.length) {
              controller.close();
              return;
            }
            const end = Math.min(bytes.length, offset === 0 ? 1 : offset + 11);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
          cancel() { canceled = true; },
        }), { headers: { "content-encoding": "gzip" } });
        response.arrayBuffer = async () => { throw new Error("recovery must consume the response stream"); };
        return response;
      };
      const recovery = runCustomBuildGenerateJob({
        id: `stream-recovery-${mode}`,
        customBuildId,
        type: "generate",
        status: "running",
        attempts: 2,
        maxAttempts: 3,
        payload: { stubBuild: { version: "1.0", blocks: [{ x: 8191, y: 0, z: 0, type: "gold_block" }] } },
      } as never, { signal: abort.signal });
      if (mode === "aborted") {
        await assert.rejects(recovery, /lease is no longer owned/);
        assert.equal(canceled, true, "lease loss should cancel the response reader");
        assert.equal(updates.some((update) => ["queued", "failed", "succeeded"].includes(String(update.data.status))), false);
      } else if (["stored-sha", "source-sha", "block-count", "stream-error"].includes(mode)) {
        await assert.rejects(recovery, /generation_retryable/);
        assert.equal(artifactCreates.length, 1, `${mode} should preserve the existing source without packaging artifacts`);
        assert.equal(updates.some((update) => update.data.status === "succeeded"), false);
      } else {
        await recovery;
        const completed = updates.find((update) => update.data.status === "succeeded");
        assert.ok(completed, `${mode} recovery should complete`);
        assert.equal(completed.data.blockCount, 128);
        assert.equal(completed.data.generationTimeMs, 1234);
        assert.equal(completed.data.buildSha256, recoveryArtifact.sourceBuildSha256, "recovery should retain the stored source instead of regenerating");
        assert.equal(completed.data.buildByteSize, artifact.byteSize);
        assert.equal(completed.data.buildCompressedByteSize, artifact.storedByteSize);
        assert.equal(artifactCreates.filter(entry => entry.kind === "build_json").length, 1, "recovery should not rewrite canonical source");
        assert.equal(artifactCreates.find(entry => entry.kind === "build_json"), artifact);
        assert.ok(updates.some(update => update.data.currentStage === "finalizing"));
      }
      assert.equal(fetches, mode === "local" ? 0 : 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
    JSON.parse = originalParse;
    for (const [key, value] of Object.entries(recoveryEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

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
