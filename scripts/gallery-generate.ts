#!/usr/bin/env -S tsx
/**
 * Generate arena builds for a selected community Gallery prompt
 *
 * Usage:
 *   pnpm gallery:generate --prompt "An accurate globe"            # plan only
 *   pnpm gallery:generate --prompt "An accurate globe" --yes      # generate and upload
 *   pnpm gallery:generate --prompt <gallery id> --top 5 --max-cost 1
 *   pnpm gallery:generate --prompt <gallery id> --models gpt-6-sol,gemini-3-8-flash --yes
 *
 * Each model runs once with benchmark generation settings. Builds publish into the
 * database and storage of the current environment through the same pending then
 * candidate-locked publication as Gallery arena imports. Runs never enter
 * benchmark metrics.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Prisma } from "@prisma/client";
import { generateVoxelBuild } from "../lib/ai/generateVoxelBuild";
import { isGridSize } from "../lib/ai/limits";
import { getAverageBenchmarkCostPerBuildUsd } from "../lib/ai/modelBenchmarkProfiles";
import { MODEL_CATALOG, type ModelKey } from "../lib/ai/modelCatalog";
import { maybePrecomputeArenaArtifactsForBuild } from "../lib/arena/artifactMaintenance";
import { deleteArenaBuildArtifacts } from "../lib/arena/artifactOwnership";
import { ARENA_BUILD_MODE } from "../lib/arena/eligibility";
import { databaseIdentityFromUrl, supabaseProjectRefFromApiUrl } from "../lib/db/identity";
import { isCommunityArenaPrompt, lockEligibleGalleryCandidate } from "../lib/gallery/arenaImport";
import {
  DEFAULT_COMMUNITY_MAX_COST_USD,
  DEFAULT_COMMUNITY_TOP,
  UNPUBLISHED_CLI_BUILD,
  coveredModelKeys,
  loadRankedModels,
  planCommunityModels,
} from "../lib/gallery/communityGeneration";
import { prisma } from "../lib/prisma";
import { deleteSupabaseStorageObjects, uploadSupabaseStorageFile } from "../lib/storage/buildPayload";
import { getBuildStorageBucketFromEnv, getSupabaseStorageConfig } from "../lib/storage/config";
import { getBatchGenerationModel } from "./batch-generate";
import { MODEL_KEY_BY_SLUG, MODEL_SLUG } from "./uploadsCatalog";

const DEFAULT_CONCURRENCY = 3;
const MAX_ATTEMPTS = 6;

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumber(args: string[], name: string, fallback: number): number {
  const raw = readFlag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function resolveModelKey(value: string): ModelKey {
  const trimmed = value.trim();
  const key = (MODEL_KEY_BY_SLUG as Record<string, ModelKey | undefined>)[trimmed]
    ?? MODEL_CATALOG.find((model) => model.key === trimmed)?.key;
  if (!key) throw new Error(`Unknown model: ${trimmed}`);
  return key;
}

function formatUsd(value: number | null): string {
  return value == null ? "unknown" : `$${value.toFixed(2)}`;
}

async function runPool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
  }));
}

// selection, existing-build checks, and publication must share one environment
function assertSingleEnvironment(): string {
  const database = databaseIdentityFromUrl(process.env.DATABASE_URL ?? "");
  const storageRef = supabaseProjectRefFromApiUrl(getSupabaseStorageConfig().url);
  if (!database?.projectRef || database.projectRef !== storageRef) {
    throw new Error(
      `DATABASE_URL (${database?.projectRef ?? "unknown"}) and Supabase storage (${storageRef ?? "unknown"}) must be the same project`,
    );
  }
  return database.projectRef;
}

type PublishTarget = { candidateId: string; promptId: string; publicId: string; modelId: string; modelSlug: string; gridSize: number; palette: string };

async function discardUnpublished(build: { id: string; voxelSha256: string | null }, source: { bucket: string; path: string }) {
  // never active, so no matchup can reference it; every step is safe to repeat
  await prisma.build.updateMany({ where: { id: build.id, active: false }, data: { arenaImportPending: false } });
  await deleteArenaBuildArtifacts({ retiringBuilds: [build], survivingChecksums: new Set(), deleteStorage: deleteSupabaseStorageObjects });
  await deleteSupabaseStorageObjects([source]);
  await prisma.build.deleteMany({ where: { id: build.id, ...UNPUBLISHED_CLI_BUILD } });
}

async function publishCommunityBuild(
  target: PublishTarget,
  generated: { build: unknown; blockCount: number; generationTimeMs: number },
  outDir: string,
): Promise<"published" | "occupied" | "withdrawn"> {
  const jsonBytes = Buffer.from(JSON.stringify(generated.build, null, 2));
  const sha256 = createHash("sha256").update(jsonBytes).digest("hex");
  const gzipped = gzipSync(jsonBytes);
  // private per run so concurrent processes never stream each other's bytes
  const filePath = path.join(outDir, `${target.modelSlug}-${randomUUID()}.json.gz`);
  fs.writeFileSync(filePath, gzipped);
  // content-addressed so concurrent runs never write each other's object
  const source = {
    bucket: getBuildStorageBucketFromEnv(),
    path: `community/${target.publicId}/${target.modelSlug}-${sha256.slice(0, 16)}-g${target.gridSize}-${target.palette}-${ARENA_BUILD_MODE}.json.gz`,
  };
  await uploadSupabaseStorageFile({ ...source, filePath, byteSize: gzipped.byteLength, contentType: "application/gzip" });

  const buildKey = {
    promptId: target.promptId,
    modelId: target.modelId,
    gridSize: target.gridSize,
    palette: target.palette,
    mode: ARENA_BUILD_MODE,
  };
  const leftover = await prisma.build.findFirst({
    where: { ...buildKey, ...UNPUBLISHED_CLI_BUILD },
    select: { id: true, voxelSha256: true, voxelStorageBucket: true, voxelStoragePath: true },
  });
  if (leftover?.voxelStorageBucket && leftover.voxelStoragePath) {
    await discardUnpublished(leftover, { bucket: leftover.voxelStorageBucket, path: leftover.voxelStoragePath });
  }
  // create-only: a slot filled after planning is kept as is
  const build = await prisma.build.create({
    data: {
      ...buildKey,
      active: false,
      arenaImportPending: true,
      voxelData: Prisma.DbNull,
      voxelStorageBucket: source.bucket,
      voxelStoragePath: source.path,
      voxelStorageEncoding: "gzip",
      voxelByteSize: jsonBytes.byteLength,
      voxelCompressedByteSize: gzipped.byteLength,
      voxelSha256: sha256,
      blockCount: generated.blockCount,
      generationTimeMs: generated.generationTimeMs,
    },
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  });
  if (!build) {
    // identical output shares the content-addressed path, so keep it if the winner uses it
    const occupant = await prisma.build.findFirst({ where: buildKey, select: { voxelStoragePath: true } });
    if (occupant?.voxelStoragePath !== source.path) await deleteSupabaseStorageObjects([source]);
    return "occupied";
  }

  let published = false;
  try {
    await maybePrecomputeArenaArtifactsForBuild(build);
    published = await prisma.$transaction(async (tx) => {
      if (!await lockEligibleGalleryCandidate(tx, target.candidateId, target.promptId)) return false;
      await tx.build.update({ where: { id: build.id }, data: { active: true, arenaImportPending: false } });
      await tx.prompt.update({ where: { id: target.promptId }, data: { active: true } });
      return true;
    });
  } finally {
    if (!published) await discardUnpublished(build, source);
  }
  return published ? "published" : "withdrawn";
}

async function main() {
  const args = process.argv.slice(2);
  const promptArg = readFlag(args, "--prompt")?.trim();
  if (!promptArg || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: pnpm gallery:generate --prompt <text|gallery id> [--top 10] [--max-cost 3] [--models a,b] [--concurrency 3] [--yes]");
    return;
  }
  const top = Math.floor(readNumber(args, "--top", DEFAULT_COMMUNITY_TOP));
  const maxCostUsd = readNumber(args, "--max-cost", DEFAULT_COMMUNITY_MAX_COST_USD);
  const concurrency = Math.floor(readNumber(args, "--concurrency", DEFAULT_CONCURRENCY));
  const explicit = (readFlag(args, "--models") ?? "").split(",").filter((value) => value.trim()).map(resolveModelKey);

  const candidate = await prisma.galleryCandidate.findFirst({
    where: {
      OR: [{ publicId: promptArg }, { promptText: promptArg }],
      selectedAt: { not: null },
      removedAt: null,
      adminHiddenAt: null,
      officialPromptId: { not: null },
    },
    select: { id: true, publicId: true, promptText: true, officialPrompt: { select: { id: true, gridSize: true, palette: true } } },
  });
  const prompt = candidate?.officialPrompt;
  if (!candidate || !prompt) throw new Error("No selected, visible Gallery prompt matches --prompt");
  if (!isGridSize(prompt.gridSize)) throw new Error(`Unsupported prompt grid size ${prompt.gridSize}`);
  const gridSize = prompt.gridSize;
  const palette = prompt.palette === "advanced" ? "advanced" : "simple";
  if (!isCommunityArenaPrompt(candidate.promptText)) throw new Error("Benchmark prompts are generated with batch:generate");

  // built, importing, or queued on the worker all count, so nothing is replaced or doubled
  const covered = await coveredModelKeys(prompt.id, candidate.publicId);
  const plan = planCommunityModels({
    ranked: await loadRankedModels(),
    costOf: getAverageBenchmarkCostPerBuildUsd as (key: ModelKey) => number | null,
    existing: covered,
    top,
    maxCostUsd,
    explicit,
  });

  console.log(`Prompt: ${candidate.promptText}`);
  console.log(`Already covered: ${covered.size}`);
  for (const model of plan) {
    const rank = Number.isFinite(model.rank) ? `#${model.rank}` : "unranked";
    console.log(`  ${rank.padStart(9)}  ${MODEL_SLUG[model.key].padEnd(28)} ${formatUsd(model.costUsd)}`);
  }
  const total = plan.reduce((sum, model) => sum + (model.costUsd ?? 0), 0);
  console.log(`Estimated cost: $${total.toFixed(2)} for ${plan.length} build${plan.length === 1 ? "" : "s"}`);
  if (plan.length === 0 || !args.includes("--yes")) {
    if (plan.length > 0) console.log("Plan only. Add --yes to generate and publish.");
    return;
  }
  // fail before any paid generation when publication cannot happen
  console.log(`Publishing to project ${assertSingleEnvironment()}, bucket ${getBuildStorageBucketFromEnv()}`);
  const modelIds = new Map((await prisma.model.findMany({
    where: { key: { in: plan.map(({ key }) => key) }, enabled: true, isBaseline: false },
    select: { id: true, key: true },
  })).map((model) => [model.key, model.id]));

  const outDir = path.join(os.tmpdir(), "minebench-gallery-generate", candidate.publicId);
  fs.mkdirSync(outDir, { recursive: true });
  const failures: string[] = [];
  const outcomes = { published: 0, occupied: 0, withdrawn: 0 };
  await runPool(plan, concurrency, async ({ key }) => {
    const modelSlug = MODEL_SLUG[key];
    const modelId = modelIds.get(key);
    if (!modelId) {
      failures.push(`${modelSlug}: not enabled in this environment`);
      return;
    }
    // a slot filled since planning is skipped before spending
    if (await prisma.build.findFirst({
      where: {
        promptId: prompt.id, modelId, gridSize, palette, mode: ARENA_BUILD_MODE,
        NOT: UNPUBLISHED_CLI_BUILD,
      },
      select: { id: true },
    })) {
      outcomes.occupied += 1;
      console.log(`  – ${modelSlug} occupied`);
      return;
    }
    console.log(`  → ${modelSlug} generating`);
    const result = await generateVoxelBuild({
      model: getBatchGenerationModel(key, false),
      prompt: candidate.promptText,
      gridSize,
      palette,
      maxAttempts: MAX_ATTEMPTS,
      enableTools: true,
      onRetry: (attempt, reason) => console.log(`    ↻ ${modelSlug} retry ${attempt}${reason ? `: ${reason}` : ""}`),
    });
    if (!result.ok) {
      failures.push(`${modelSlug}: ${result.error}`);
      return;
    }
    try {
      const outcome = await publishCommunityBuild(
        { candidateId: candidate.id, promptId: prompt.id, publicId: candidate.publicId, modelId, modelSlug, gridSize, palette },
        result,
        outDir,
      );
      outcomes[outcome] += 1;
      console.log(`  ${outcome === "published" ? "✓" : "–"} ${modelSlug} ${outcome}`);
    } catch (error) {
      failures.push(`${modelSlug}: ${error instanceof Error ? error.message : String(error)} (saved in ${outDir})`);
    }
  });

  console.log(`Done: ${outcomes.published} published, ${outcomes.occupied} already built, ${outcomes.withdrawn} withdrawn`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
