import assert from "node:assert/strict";

const now = new Date();
const initial = {
  id: "recovery-build", publicId: "cb_recovery", ownerId: "recovery-owner",
  status: "failed", currentStage: "failed", errorCode: "lease_expired", errorRetryable: true,
  removedAt: null as Date | null, createdAt: now, updatedAt: now, startedAt: now, completedAt: now,
  progress: null, warnings: null, artifacts: [], modelKind: "catalog", modelProvider: "openai",
  modelKey: "openai_gpt_6_astra", modelId: "gpt-6-astra", preferOpenRouter: false, usesHostedGeneration: false,
};
let current: Record<string, unknown> = { ...initial };
let artifactKind: string | undefined;
let deletedCredentials = 0;
const credentials: Array<Record<string, unknown>> = [];
const jobs: Array<Record<string, unknown>> = [];
const fakePrisma = {
  customBuild: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      where.ownerId === current.ownerId && where.publicId === current.publicId && current.removedAt === null ? current : null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (Object.entries(where).some(([key, value]) => current[key] !== value)) return { count: 0 };
      current = { ...current, ...data };
      return { count: 1 };
    },
  },
  customBuildArtifact: {
    findFirst: async ({ where }: { where: { customBuildId: string; kind: { in: string[] } } }) =>
      where.customBuildId === current.id && artifactKind && where.kind.in.includes(artifactKind) ? { id: "saved-source" } : null,
  },
  customBuildSecret: {
    deleteMany: async () => { deletedCredentials += 1; return { count: 1 }; },
    create: async ({ data }: { data: Record<string, unknown> }) => { credentials.push(data); return data; },
  },
  customBuildJob: { create: async ({ data }: { data: Record<string, unknown> }) => { jobs.push(data); return data; } },
  customBuildEvent: { aggregate: async () => ({ _max: { seq: 1 } }), create: async () => ({}) },
  $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(fakePrisma),
};
(globalThis as unknown as { prisma?: unknown }).prisma = fakePrisma;

function reset(errorCode = "lease_expired", kind?: string) {
  current = { ...initial, errorCode };
  artifactKind = kind;
  deletedCredentials = 0;
  credentials.length = 0;
  jobs.length = 0;
}

async function main() {
  const { retrySavedGeneration } = await import("../../../lib/generations/service");
  const retry = (input = {}) => retrySavedGeneration(initial.ownerId, initial.publicId, input);
  const codeIs = (code: string) => (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;

  for (const errorCode of ["lease_expired", "provider_key_expired", "artifact_bookkeeping_failed"]) {
    for (const kind of ["raw_text_debug", "build_json"]) {
      reset(errorCode, kind);
      current.modelKind = "custom";
      current.modelProvider = "custom";
      assert.equal((await retry()).status, "queued", `${errorCode} should recover ${kind} without a key or endpoint`);
      assert.equal(deletedCredentials, 1);
      assert.equal(credentials.length, 0, "artifact recovery must never recreate credentials");
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.type, "generate", "recovery uses the existing generation worker");
      assert.equal(jobs[0]!.maxAttempts, 2);
      assert.equal(current.deletionPendingAt, null);
    }
    for (const kind of [undefined, "preview_svg"]) {
      reset(errorCode, kind);
      await assert.rejects(retry({ providerKey: "unused-provider-key" }), codeIs("not_retryable"));
      assert.equal(deletedCredentials, 0);
      assert.equal(credentials.length, 0);
      assert.equal(jobs.length, 0, "missing output must not fall back to fresh inference");
    }
  }

  reset("lease_expired", "build_json");
  await retry({ providerKey: "unused-provider-key", customBaseUrl: "invalid", customHeaders: { "": "invalid" } });
  assert.equal(credentials.length, 0, "recovery ignores supplied provider configuration");

  for (const state of [{ status: "canceled" }, { removedAt: now }]) {
    reset("lease_expired", "raw_text_debug");
    Object.assign(current, state);
    await assert.rejects(retry(), codeIs("removedAt" in state ? "not_found" : "not_retryable"));
    assert.equal(deletedCredentials, 0);
    assert.equal(jobs.length, 0);
  }

  reset("generation_failed", "raw_text_debug");
  await assert.rejects(retry(), codeIs("missing_provider_key"));
  assert.equal(jobs.length, 0, "invalid model output keeps its existing credential requirement");

  for (const kind of ["raw_text_debug", "build_json", undefined]) {
    reset("generation_failed", kind);
    Object.assign(current, { generationMode: "import", modelKind: "import", modelProvider: "import" });
    if (kind) {
      assert.equal((await retry()).status, "queued");
      assert.equal(credentials.length, 0, "import retries use saved source without a provider key");
    } else {
      await assert.rejects(retry(), codeIs("not_retryable"));
      assert.equal(jobs.length, 0, "missing import source must not queue a provider request");
    }
  }

  const previousSecret = process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET;
  const previousHostedKey = process.env.MINEBENCH_FREE_OPENROUTER_API_KEY;
  process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = "unit-retry-recovery-encryption-secret";
  process.env.MINEBENCH_FREE_OPENROUTER_API_KEY = "unit-hosted-retry-key";
  try {
    for (const kind of [undefined, "raw_text_debug"]) {
      reset("generation_failed", kind);
      assert.equal((await retry({ providerKey: "unit-provider-retry-key" })).status, "queued");
      assert.equal(credentials.length, 1, "ordinary manual retry still stores the supplied key");
      assert.notEqual(credentials[0]!.keyCiphertext, "unit-provider-retry-key");
    }
    reset("generation_failed");
    Object.assign(current, { modelKey: "gemini_3_7_flash", modelProvider: "gemini", preferOpenRouter: true, usesHostedGeneration: true });
    await retry();
    assert.equal(credentials[0]!.provider, "openrouter", "historical hosted retries keep their existing key source");
    reset("provider_key_expired", "raw_text_debug");
    Object.assign(current, { modelKey: "gemini_3_7_flash", modelProvider: "gemini", preferOpenRouter: true, usesHostedGeneration: true });
    await retry();
    assert.equal(credentials.length, 0, "hosted recovery must not store a key for a replacement request");
  } finally {
    if (previousSecret === undefined) delete process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET;
    else process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET = previousSecret;
    if (previousHostedKey === undefined) delete process.env.MINEBENCH_FREE_OPENROUTER_API_KEY;
    else process.env.MINEBENCH_FREE_OPENROUTER_API_KEY = previousHostedKey;
  }
  console.log("saved-generation retry recovery checks passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
