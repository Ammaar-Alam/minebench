import "dotenv/config";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { getModelByKey, MODEL_CATALOG, type ModelKey } from "@/lib/ai/modelCatalog";
import type { ProviderApiKeys } from "@/lib/ai/types";
import { LOCAL_BUILD_STORAGE_BUCKET } from "@/lib/storage/buildPayload";
import { generateCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { sha256Hex } from "@/lib/custom-builds/artifacts";
import { createCustomBuildArtifactSignedUrl, downloadCustomBuildArtifactBytes } from "@/lib/custom-builds/storage";
import { encryptProviderKey } from "@/lib/custom-builds/secrets";
import { runCustomBuildWorkerOnce } from "@/lib/custom-builds/worker";
import { prisma } from "@/lib/prisma";
import type { VoxelBuild } from "@/lib/voxel/types";

process.env.CUSTOM_BUILD_STUB_PROVIDER = "1";
process.env.CUSTOM_BUILD_STORAGE_BUCKET = LOCAL_BUILD_STORAGE_BUCKET;
process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR =
  process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR?.trim() || ".custom-build-storage/verify";
process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET =
  process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET?.trim() || "custom-build-verify-secret";

type SmokeProvider = keyof ProviderApiKeys | "openrouter";

const DEFAULT_SMOKE_PROMPT = "Build a small 16x16 stone arch with two pillars and a flat base.";
const DEFAULT_SMOKE_MODEL_CANDIDATES: ModelKey[] = [
  "openai_gpt_5_4_nano",
  "openai_gpt_5_nano",
  "gemini_3_1_flash_lite",
  "gemini_3_0_flash",
  "openai_gpt_5_4_mini",
];

function fixtureBuild(): VoxelBuild {
  const blocks: VoxelBuild["blocks"] = [];
  for (let x = 0; x < 16; x += 1) {
    for (let z = 0; z < 16; z += 1) {
      blocks.push({ x, y: 0, z, type: "stone" });
    }
  }
  for (let y = 1; y <= 12; y += 1) {
    blocks.push({ x: 3, y, z: 8, type: "stone_bricks" });
    blocks.push({ x: 12, y, z: 8, type: "stone_bricks" });
  }
  for (let x = 3; x <= 12; x += 1) {
    const height = 12 + Math.round(Math.sin(((x - 3) / 9) * Math.PI) * 4);
    blocks.push({ x, y: height, z: 8, type: "stone_bricks" });
  }
  return { version: "1.0", blocks };
}

function assertSafeVerificationDatabase() {
  if (process.env.CUSTOM_BUILD_VERIFY_ALLOW_REMOTE === "1") return;
  if (process.env.MINEBENCH_LOCAL_ENV === "1") return;
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const url = new URL(raw);
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return;
  } catch {
    // Prisma will report the missing/invalid URL more precisely if the caller opts in.
  }
  throw new Error(
    "custom:verify only runs against the local database by default. Use `pnpm env:localdb` and `pnpm local:prisma:migrate`, then run it through `node scripts/with-local-env.mjs pnpm custom:verify`.",
  );
}

function keyEnvForSmokeProvider(provider: SmokeProvider): string {
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "gemini") return "GOOGLE_AI_API_KEY";
  if (provider === "moonshot") return "MOONSHOT_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "minimax") return "MINIMAX_API_KEY";
  if (provider === "xai") return "XAI_API_KEY";
  if (provider === "custom") return "CUSTOM_API_KEY";
  throw new Error(`Unsupported smoke provider: ${provider}`);
}

function readSmokeProvider(): SmokeProvider {
  const provider = (process.env.CUSTOM_BUILD_SMOKE_PROVIDER?.trim() || "openrouter") as SmokeProvider;
  if (
    provider === "openrouter" ||
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "gemini" ||
    provider === "moonshot" ||
    provider === "deepseek" ||
    provider === "minimax" ||
    provider === "xai" ||
    provider === "custom"
  ) {
    return provider;
  }
  throw new Error("CUSTOM_BUILD_SMOKE_PROVIDER must be openrouter, openai, anthropic, gemini, moonshot, deepseek, minimax, xai, or custom");
}

function readSmokeTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.CUSTOM_BUILD_SMOKE_TIMEOUT_MS ?? "600000", 10);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.min(parsed, 30 * 60_000)) : 600_000;
}

function chooseSmokeModelKey(provider: SmokeProvider): ModelKey {
  const configured = process.env.CUSTOM_BUILD_SMOKE_MODEL_KEY?.trim();
  if (configured) {
    return getModelByKey(configured as ModelKey).key;
  }

  for (const key of DEFAULT_SMOKE_MODEL_CANDIDATES) {
    const model = getModelByKey(key);
    if (!model.enabled) continue;
    if (provider === "openrouter" && model.openRouterModelId) return model.key;
    if (provider !== "openrouter" && model.provider === provider) return model.key;
  }

  const fallback = MODEL_CATALOG.find((model) => {
    if (!model.enabled) return false;
    if (provider === "openrouter") return Boolean(model.openRouterModelId);
    return model.provider === provider;
  });
  if (!fallback) {
    throw new Error(`No enabled catalog model is available for CUSTOM_BUILD_SMOKE_PROVIDER=${provider}`);
  }
  return fallback.key;
}

async function drainCustomBuildJobs(customBuildId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCustomBuildWorkerOnce("verify-worker");
    if (!result.processed) {
      const build = await prisma.customBuild.findUniqueOrThrow({
        where: { id: customBuildId },
        include: { jobs: true },
      });
      if (build.status === "failed" || build.status === "canceled") {
        throw new Error(build.errorMessage ?? `Custom build ended with status ${build.status}`);
      }
      if (build.jobs.every((job) => job.status === "succeeded" || job.status === "failed" || job.status === "canceled")) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for custom build jobs`);
}

async function assertCompletedArtifacts(customBuildId: string, minimumBlocks: number) {
  const completed = await prisma.customBuild.findUniqueOrThrow({
    where: { id: customBuildId },
    include: {
      artifacts: { orderBy: { kind: "asc" } },
      events: { orderBy: { seq: "asc" } },
      jobs: true,
      secret: true,
    },
  });

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.secret, null);
  assert.ok((completed.blockCount ?? 0) >= minimumBlocks);
  assert.ok(completed.buildSha256);
  assert.ok(completed.artifacts.some((artifact) => artifact.kind === "build_json"));
  assert.ok(completed.artifacts.some((artifact) => artifact.kind === "preview_json"));
  assert.ok(completed.artifacts.some((artifact) => artifact.kind === "glb"));
  assert.ok(completed.artifacts.some((artifact) => artifact.kind === "schem"));
  assert.ok(completed.events.some((event) => event.type === "complete"));
  assert.ok(completed.events.some((event) => event.type === "export_complete"));

  const json = completed.artifacts.find((artifact) => artifact.kind === "build_json");
  assert.ok(json);
  const jsonBytes = await downloadCustomBuildArtifactBytes({ bucket: json.bucket, path: json.path });
  const storedBuild = JSON.parse(gunzipSync(jsonBytes).toString("utf8")) as VoxelBuild;
  assert.equal(storedBuild.blocks.length, completed.blockCount);
  const signedUrl = await createCustomBuildArtifactSignedUrl({ bucket: json.bucket, path: json.path });
  assert.match(signedUrl, /^file:\/\//);

  const glb = completed.artifacts.find((artifact) => artifact.kind === "glb");
  assert.ok(glb);
  const glbBytes = await downloadCustomBuildArtifactBytes({ bucket: glb.bucket, path: glb.path });
  assert.equal(Buffer.from(glbBytes.subarray(0, 4)).toString("utf8"), "glTF");

  const schem = completed.artifacts.find((artifact) => artifact.kind === "schem");
  assert.ok(schem);
  const schemBytes = await downloadCustomBuildArtifactBytes({ bucket: schem.bucket, path: schem.path });
  assert.doesNotThrow(() => gunzipSync(schemBytes));

  return completed;
}

async function runStubVerification() {
  const publicId = generateCustomBuildPublicId();
  const prompt = "Build a small stone arch with two pillars and a flat base.";
  const build = fixtureBuild();

  const customBuild = await prisma.customBuild.create({
    data: {
      publicId,
      status: "queued",
      promptText: prompt,
      promptSha256: sha256Hex(prompt),
      gridSize: 64,
      palette: "simple",
      modelKind: "catalog",
      modelKey: "gemini_3_5_flash",
      modelProvider: "gemini",
      modelId: "gemini-3.5-flash",
      modelDisplayName: "Gemini 3.5 Flash",
      openRouterModelId: "google/gemini-3.5-flash",
      jobs: {
        create: {
          type: "generate",
          status: "queued",
          payload: {
            requestedExports: ["glb", "schem"],
            stubBuild: build,
          },
        },
      },
      events: {
        create: {
          seq: 1,
          type: "queued",
          data: { stage: "queued" },
        },
      },
    },
  });

  try {
    assert.deepEqual(await runCustomBuildWorkerOnce("verify-worker"), {
      processed: true,
      jobType: "generate",
      jobId: (await prisma.customBuildJob.findFirstOrThrow({
        where: { customBuildId: customBuild.id, type: "generate" },
        select: { id: true },
      })).id,
    });
    assert.equal((await runCustomBuildWorkerOnce("verify-worker")).processed, true);
    assert.equal((await runCustomBuildWorkerOnce("verify-worker")).processed, true);

    await assertCompletedArtifacts(customBuild.id, 200);

    console.log(`custom build verification passed for ${publicId}`);
  } finally {
    await prisma.customBuild.deleteMany({ where: { id: customBuild.id } });
  }
}

async function runSmokeVerification() {
  if (process.env.CUSTOM_BUILD_SMOKE !== "1") return;

  const provider = readSmokeProvider();
  const keyEnv = keyEnvForSmokeProvider(provider);
  const providerKey = process.env[keyEnv]?.trim();
  if (!providerKey) {
    throw new Error(`CUSTOM_BUILD_SMOKE=1 requires ${keyEnv} to be set`);
  }

  const modelKey = chooseSmokeModelKey(provider);
  const model = getModelByKey(modelKey);
  if (provider === "openrouter" && !model.openRouterModelId) {
    throw new Error(`${model.key} cannot run through OpenRouter because it has no OpenRouter model ID`);
  }
  if (provider !== "openrouter" && model.provider !== provider) {
    throw new Error(`${model.key} belongs to ${model.provider}, not CUSTOM_BUILD_SMOKE_PROVIDER=${provider}`);
  }

  const publicId = generateCustomBuildPublicId();
  const encrypted = encryptProviderKey(providerKey, { provider });
  const customBuild = await prisma.customBuild.create({
    data: {
      publicId,
      status: "queued",
      currentStage: "queued",
      promptText: DEFAULT_SMOKE_PROMPT,
      promptSha256: sha256Hex(DEFAULT_SMOKE_PROMPT),
      gridSize: 64,
      palette: "simple",
      modelKind: "catalog",
      modelKey: model.key,
      modelProvider: model.provider,
      modelId: model.modelId,
      modelDisplayName: model.displayName,
      openRouterModelId: model.openRouterModelId,
      preferOpenRouter: provider === "openrouter",
      secret: {
        create: {
          provider: encrypted.provider,
          keyCiphertext: encrypted.keyCiphertext,
          keyIv: encrypted.keyIv,
          keyAuthTag: encrypted.keyAuthTag,
          keyVersion: encrypted.keyVersion,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      },
      jobs: {
        create: {
          type: "generate",
          status: "queued",
          maxAttempts: 1,
          payload: { requestedExports: ["glb", "schem"] },
        },
      },
      events: {
        create: {
          seq: 1,
          type: "queued",
          data: { stage: "queued" },
        },
      },
    },
  });

  try {
    await drainCustomBuildJobs(customBuild.id, readSmokeTimeoutMs());
    await assertCompletedArtifacts(customBuild.id, 1);
    console.log(`custom build smoke verification passed for ${publicId} with ${model.key} via ${provider}`);
  } finally {
    await prisma.customBuild.deleteMany({ where: { id: customBuild.id } });
  }
}

async function main() {
  assertSafeVerificationDatabase();
  try {
    await runStubVerification();
    await runSmokeVerification();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
