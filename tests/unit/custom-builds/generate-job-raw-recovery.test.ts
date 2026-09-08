import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

const customBuildId = "raw-recovery-row";
const publicId = "cb_123456789012345678901234";
const storageDir = ".custom-build-storage/unit-raw-recovery";
const previousEnv = Object.fromEntries([
  "CUSTOM_BUILD_STORAGE_BUCKET", "CUSTOM_BUILD_LOCAL_STORAGE_DIR", "CUSTOM_BUILD_STUB_PROVIDER",
  "SUPABASE_URL", "SUPABASE_SECRET_KEY", "OPENROUTER_BASE_URL", "MINEBENCH_TOOL_TIMEOUT_MS",
  "CUSTOM_BUILD_KEY_ENCRYPTION_SECRET", "OPENAI_BACKGROUND_POLL_MS", "OPENAI_USE_BACKGROUND_MODE",
].map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const artifacts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const queries: string[] = [];
let keyLookups = 0;
let providerRequests = 0;
let expiredKey = false;
let savedSecret: Record<string, unknown> | null = null;
let savedJobPayload: Record<string, unknown> = {};
let eventSeq = 0;
let current: Record<string, unknown>;
const initial = {
  id: customBuildId, publicId, status: "queued", currentStage: "queued", removedAt: null,
  promptText: "A seeded stone tower", promptSha256: "raw-recovery-prompt",
  gridSize: 8192, palette: "simple", modelKind: "catalog", modelKey: "qwen_qwen3_8_max",
  modelProvider: "openrouter", modelId: "qwen/qwen3.8-max", modelDisplayName: "Qwen 3.8 Max",
  openRouterModelId: "qwen/qwen3.8-max", preferOpenRouter: true, reasoning: null,
  customBaseUrl: null, startedAt: null, generationTimeMs: 1234, warnings: ["stored warning"],
};
const fakePrisma = {
  customBuild: {
    findUnique: async () => current,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      updates.push(data);
      current = { ...current, ...data };
      return current;
    },
    updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      updates.push(data);
      current = { ...current, ...data };
      return { count: 1 };
    },
  },
  customBuildArtifact: {
    findFirst: async (args: { where: { kind: string }; orderBy: unknown }) => {
      queries.push(args.where.kind);
      if (args.where.kind === "raw_text_debug") {
        assert.deepEqual(args.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
      }
      return artifacts.findLast((artifact) => artifact.kind === args.where.kind) ?? null;
    },
    findUnique: async () => null,
    upsert: async ({ create }: { create: Record<string, unknown> }) => {
      const index = artifacts.findIndex((artifact) => artifact.kind === create.kind &&
        artifact.sourceBuildSha256 === create.sourceBuildSha256);
      if (index < 0) artifacts.push(create);
      else artifacts[index] = create;
      return create;
    },
    aggregate: async () => ({ _sum: {
      storedByteSize: artifacts.reduce((sum, artifact) => sum + Number(artifact.storedByteSize), 0),
    } }),
  },
  customBuildSecret: {
    findUnique: async () => {
      keyLookups += 1;
      return savedSecret ?? (expiredKey ? { expiresAt: new Date(0) } : null);
    },
    deleteMany: async () => ({ count: 0 }),
  },
  customBuildJob: {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { payload: Record<string, unknown> } }) => {
      assert.deepEqual(where, { id: job.id, status: "running", lockedBy: "unit-background-worker" });
      savedJobPayload = data.payload;
      return { count: 1 };
    },
  },
  customBuildStatsDaily: { upsert: async () => ({}) },
  customBuildEvent: {
    aggregate: async () => ({ _max: { seq: eventSeq } }),
    create: async ({ data }: { data: { seq: number } }) => { eventSeq = data.seq; return data; },
  },
  $queryRaw: async () => [{ id: customBuildId }],
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(fakePrisma),
};
(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

const toolCall = (code: string, gridSize = 8192, palette = "simple") => JSON.stringify({
  tool: "voxel.exec", input: { code, gridSize, palette, seed: 123 },
});
const validText = toolCall([
  "box(0, 0, 0, 79, 51, 1, 'stone');",
  "block(Math.floor(rng() * 80), 52, 0, 'gold_block');",
  "block(-1, 0, 0, 'stone'); block(0, 0, 0, 'unknown_material');",
].join("\n"));
const job = { id: "raw-recovery-job", customBuildId, type: "generate", status: "running",
  attempts: 1, maxAttempts: 3, payload: {} };

function reset() {
  current = { ...initial };
  artifacts.length = 0;
  updates.length = 0;
  queries.length = 0;
  keyLookups = 0;
  providerRequests = 0;
  savedSecret = null;
  savedJobPayload = {};
  globalThis.fetch = async () => {
    providerRequests += 1;
    throw new Error("Replay must not contact a provider");
  };
}

async function main() {
  process.env.CUSTOM_BUILD_STORAGE_BUCKET = "__local_fs__";
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR = storageDir;
  delete process.env.CUSTOM_BUILD_STUB_PROVIDER;
  process.env.MINEBENCH_TOOL_TIMEOUT_MS = "250";
  const { processVoxelBuildResponseInWorker } = await import("../../../scripts/process-voxel-build-response");
  const { runCustomBuildGenerateJob } = await import("../../../lib/custom-builds/generateJob");
  const { generateVoxelBuild } = await import("../../../lib/ai/generateVoxelBuild");
  const { uploadAndRecordCustomBuildArtifact, writeVoxelBuildSourceArtifact, gzipBytes, sha256Hex } =
    await import("../../../lib/custom-builds/artifacts");
  const { setMetricLogWriter } = await import("../../../lib/observability/cloudwatch");
  const { CustomBuildLeaseLostError } = await import("../../../lib/custom-builds/lease");
  setMetricLogWriter(() => {});
  const saveRaw = async (text: string, gzip = false) => {
    const bytes = new TextEncoder().encode(text);
    return uploadAndRecordCustomBuildArtifact({ customBuildId, publicId, kind: "raw_text_debug",
      bytes: gzip ? gzipBytes(bytes) : bytes, sourceBuildSha256: sha256Hex(bytes),
      uncompressedByteSize: bytes.length, encoding: gzip ? "gzip" : "identity", exportStats: { attempt: 2 },
    });
  };
  const assertNoProvider = () => {
    assert.equal(keyLookups, 0, "saved responses must be processed before provider key lookup");
    assert.equal(providerRequests, 0, "saved response failures must not buy another generation");
  };

  reset();
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api";
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: validText } }] });
  const fresh = await generateVoxelBuild({ modelKey: "qwen_qwen3_8_max", prompt: initial.promptText,
    gridSize: 8192, palette: "simple", maxAttempts: 1, buildOutput: "packed",
    providerKeys: { openrouter: "unit-raw-recovery-key" }, allowServerKeys: false,
  });
  if (!fresh.ok) throw new Error(fresh.error);
  assert.ok(fresh.warnings.length > 0, "fixture should exercise validation warnings");
  const expected = await writeVoxelBuildSourceArtifact(fresh.build);
  const expectedSourceSha = expected.sourceSha256;
  await expected.cleanup();

  for (const mode of ["missing-key", "expired-key-gzip", "decoded-http"] as const) {
    reset();
    expiredKey = mode === "expired-key-gzip";
    if (mode === "missing-key") current.generationTimeMs = null;
    const raw = await saveRaw(validText, mode !== "missing-key");
    let gateCalls = 0;
    if (mode === "decoded-http") {
      raw.bucket = "raw-recovery-private";
      process.env.SUPABASE_URL = "http://127.0.0.1:43198";
      process.env.SUPABASE_SECRET_KEY = "unit-raw-recovery-storage-key";
      globalThis.fetch = async (input, init) => {
        assert.equal(gateCalls, 1, "recovery should acquire processing before downloading");
        assert.equal(String(input), `http://127.0.0.1:43198/storage/v1/object/${raw.bucket}/${raw.path}`);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer unit-raw-recovery-storage-key");
        return new Response(validText, { headers: { "content-encoding": "gzip" } });
      };
    }
    await runCustomBuildGenerateJob(job as never, {
      acquireBuildProcessing: async () => { gateCalls += 1; return () => {}; },
      processResponse: processVoxelBuildResponseInWorker,
    });
    assertNoProvider();
    assert.equal(gateCalls, 1);
    assert.equal(current.status, "succeeded");
    assert.equal(current.blockCount, fresh.blockCount);
    assert.equal(current.buildSha256, expectedSourceSha, "replay must match fresh seeded generation exactly");
    assert.equal(current.generationTimeMs, mode === "missing-key" ? null : 1234);
    assert.deepEqual(current.warnings, ["stored warning", ...fresh.warnings]);
    assert.equal((current.metrics as Record<string, unknown>).sourceArtifactSha256, raw.sourceBuildSha256);
    for (const kind of ["raw_text_debug", "build_json", "viewer_world", "world_part", "preview_mbv4", "preview_svg"]) {
      assert.ok(artifacts.some((artifact) => artifact.kind === kind), `${mode} should preserve ${kind}`);
    }
    assert.ok(updates.some((update) => update.currentStage === "finalizing"));
  }

  const completedArtifacts = [...artifacts];
  reset();
  artifacts.push(...completedArtifacts);
  await saveRaw("invalid newer raw response");
  await runCustomBuildGenerateJob(job as never);
  assertNoProvider();
  assert.deepEqual(queries, ["build_json"], "canonical recovery must take precedence over raw responses");
  assert.equal(current.buildSha256, expectedSourceSha);

  for (const text of ["invalid JSON", "{}", toolCall("block(0,0,0,'stone');"),
    toolCall("box(0,0,0,15,60,1,'stone');"), toolCall("box(0,0,0,79,5,1,'stone');"),
    toolCall("box(0,0,0,79,51,1,'stone');", 4096),
    toolCall("box(0,0,0,79,51,1,'stone');", 8192, "advanced"),
    toolCall("const = 1;"), toolCall("while (true) {}")]) {
    reset();
    await saveRaw(validText);
    const raw = await saveRaw(text);
    await assert.rejects(runCustomBuildGenerateJob(job as never), /generation_failed/);
    assertNoProvider();
    assert.equal(current.status, "failed");
    assert.equal(current.errorRetryable, true);
    assert.equal(current.deletionPendingAt, null, "failed execution must retain the saved response");
    assert.equal((current.progress as Record<string, unknown>).attempt, 2);
    assert.equal(artifacts.length, 2, "recovery should neither replace the raw response nor package invalid geometry");
    assert.equal(artifacts[1], raw, "recovery must use the latest response");
    assert.equal(updates.some((update) => update.status === "queued"), false);
  }

  for (const mode of ["stored-sha", "source-sha", "missing-sha", "stored-size", "gzip-size"] as const) {
    reset();
    const raw = await saveRaw(mode === "gzip-size" ? " ".repeat(8 * 1024 * 1024 + 1) : validText, mode === "gzip-size");
    if (mode === "stored-sha") raw.sha256 = "0".repeat(64);
    if (mode === "source-sha") raw.sourceBuildSha256 = "0".repeat(64);
    if (mode === "missing-sha") raw.sourceBuildSha256 = "";
    if (mode === "stored-size") raw.storedByteSize = BigInt(8 * 1024 * 1024 + 1);
    await assert.rejects(runCustomBuildGenerateJob(job as never), /generation_retryable/);
    assertNoProvider();
    assert.equal(current.status, "queued", `${mode} should retry only saved artifact recovery`);
    assert.equal(artifacts.length, 1);
  }

  for (const mode of ["stream-size", "stream-error", "stream-abort"] as const) {
    reset();
    const raw = await saveRaw(validText);
    raw.bucket = "raw-recovery-private";
    const streamAbort = new AbortController();
    let canceled = false;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "stream-error") controller.error(new Error("Storage read interrupted"));
        else {
          controller.enqueue(new Uint8Array(mode === "stream-size" ? 8 * 1024 * 1024 + 1 : 1));
          if (mode === "stream-abort") streamAbort.abort(new CustomBuildLeaseLostError());
        }
      },
      cancel() { canceled = true; },
    }));
    await assert.rejects(runCustomBuildGenerateJob(job as never, { signal: streamAbort.signal }),
      mode === "stream-abort" ? /lease is no longer owned/ : /generation_retryable/);
    assertNoProvider();
    assert.equal(artifacts.length, 1);
    if (mode !== "stream-error") assert.equal(canceled, true, "incomplete recovery must cancel its reader");
    if (mode === "stream-abort") {
      assert.equal(updates.some((update) => ["queued", "failed", "succeeded"].includes(String(update.status))), false);
    }
  }

  reset();
  await saveRaw(validText);
  const abort = new AbortController();
  await assert.rejects(runCustomBuildGenerateJob(job as never, {
    signal: abort.signal,
    acquireBuildProcessing: async () => { abort.abort(new CustomBuildLeaseLostError()); return () => {}; },
  }), /lease is no longer owned/);
  assertNoProvider();
  assert.equal(artifacts.length, 1);
  assert.equal(updates.some((update) => ["queued", "failed", "succeeded"].includes(String(update.status))), false);
  reset();
  await assert.rejects(runCustomBuildGenerateJob(job as never), /provider_key_expired/);
  assert.equal(providerRequests, 0, "missing output after a keyless retry must not buy another generation");
  assert.equal(current.status, "failed");
  reset();
  process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = "unit-background-response-recovery-secret";
  process.env.OPENAI_BACKGROUND_POLL_MS = "0";
  process.env.OPENAI_USE_BACKGROUND_MODE = "1";
  const { encryptProviderKey } = await import("../../../lib/custom-builds/secrets");
  savedSecret = { ...encryptProviderKey("unit-openai-background-key", { provider: "openai", binding: customBuildId }),
    expiresAt: new Date(Date.now() + 60_000) };
  current = { ...initial, modelKey: "openai_gpt_6_astra", modelProvider: "openai",
    modelId: "gpt-6-astra", preferOpenRouter: false, generationTimeMs: null };
  const interrupted = new AbortController();
  const backgroundJob = { ...job, lockedBy: "unit-background-worker" };
  const responseId = "resp_interrupted_generation";
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST") return Response.json({ id: responseId, status: "queued" });
    assert.equal(savedJobPayload.openaiResponseId, responseId, "the response ID must be durable before polling");
    interrupted.abort(new CustomBuildLeaseLostError());
    throw new DOMException("Interrupted", "AbortError");
  };
  await assert.rejects(runCustomBuildGenerateJob(backgroundJob as never, { signal: interrupted.signal }), /lease is no longer owned/);
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(artifacts.length, 0);
  methods.length = 0;
  current = { ...current, status: "queued", currentStage: "queued" };
  globalThis.fetch = async (input, init) => {
    methods.push(init?.method ?? "GET");
    assert.equal(String(input), `https://api.openai.com/v1/responses/${responseId}`);
    return Response.json({ id: responseId, status: "completed", output_text: validText });
  };
  await runCustomBuildGenerateJob({ ...backgroundJob, payload: savedJobPayload } as never, {
    processResponse: processVoxelBuildResponseInWorker,
  });
  assert.deepEqual(methods, ["GET"], "reclaimed jobs must retrieve the original response without a new generation");
  assert.equal(current.status, "succeeded");
  assert.equal(current.buildSha256, expectedSourceSha);
  assert.equal(current.generationTimeMs, null, "interrupted inference timing is unknown");
  assert.ok(artifacts.some((artifact) => artifact.kind === "raw_text_debug"));
  assert.ok(artifacts.some((artifact) => artifact.kind === "viewer_world"));
  console.log("saved raw response recovery checks passed");
}

void main().finally(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(storageDir, { recursive: true, force: true });
}).catch((error) => { console.error(error); process.exitCode = 1; });
