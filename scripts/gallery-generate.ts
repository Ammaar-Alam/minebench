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
 * Each model runs once with benchmark generation settings and uploads through the
 * same import path as batch:generate. Runs never enter benchmark metrics.
 */
import "dotenv/config";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateVoxelBuild } from "../lib/ai/generateVoxelBuild";
import { getAverageBenchmarkCostPerBuildUsd } from "../lib/ai/modelBenchmarkProfiles";
import { MODEL_CATALOG, type ModelKey } from "../lib/ai/modelCatalog";
import { ARENA_BUILD_GRID_SIZE, ARENA_BUILD_MODE, ARENA_BUILD_PALETTE } from "../lib/arena/eligibility";
import { isCommunityArenaPrompt } from "../lib/gallery/arenaImport";
import { prisma } from "../lib/prisma";
import { getBatchGenerationModel, uploadBuild, type Job } from "./batch-generate";
import { galleryDatabaseTarget } from "./gallery-cli";
import { MODEL_KEY_BY_SLUG, MODEL_SLUG } from "./uploadsCatalog";

const DEFAULT_TOP = 10;
const DEFAULT_MAX_COST_USD = 3;
const DEFAULT_CONCURRENCY = 3;
const MAX_ATTEMPTS = 6;

export type RankedModel = { key: ModelKey; rank: number };
export type PlannedModel = RankedModel & { costUsd: number | null };

// top ranked models under the price cap, or the explicit list, minus models already built
export function planCommunityModels(opts: {
  ranked: RankedModel[];
  costOf: (key: ModelKey) => number | null;
  existing: Set<string>;
  top: number;
  maxCostUsd: number;
  explicit: ModelKey[];
}): PlannedModel[] {
  const rankOf = new Map(opts.ranked.map((model) => [model.key, model.rank]));
  const candidates: PlannedModel[] = opts.explicit.length > 0
    ? opts.explicit.map((key) => ({ key, rank: rankOf.get(key) ?? Number.POSITIVE_INFINITY, costUsd: opts.costOf(key) }))
    : opts.ranked.map((model) => ({ ...model, costUsd: opts.costOf(model.key) }));
  const affordable = candidates.filter(({ costUsd }) =>
    costUsd == null ? opts.explicit.length > 0 : costUsd <= opts.maxCostUsd,
  );
  const picked = opts.explicit.length > 0 ? affordable : affordable.slice(0, opts.top);
  return picked.filter((model) => !opts.existing.has(model.key));
}

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

async function loadRankedModels(): Promise<RankedModel[]> {
  const latest = await prisma.modelRankSnapshot.findFirst({
    orderBy: { capturedAt: "desc" },
    select: { capturedAt: true },
  });
  if (!latest) return [];
  const rows = await prisma.modelRankSnapshot.findMany({
    where: { capturedAt: latest.capturedAt, model: { enabled: true, isBaseline: false, stealthVariant: null } },
    orderBy: { rank: "asc" },
    select: { rank: true, model: { select: { key: true } } },
  });
  const generatable = new Set(MODEL_CATALOG.filter((model) => model.enabled && !model.importOnly).map((model) => model.key));
  return rows
    .filter((row) => generatable.has(row.model.key as ModelKey))
    .map((row) => ({ key: row.model.key as ModelKey, rank: row.rank }));
}

async function runPool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const promptArg = readFlag(args, "--prompt")?.trim();
  if (!promptArg || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: pnpm gallery:generate --prompt <text|gallery id> [--top 10] [--max-cost 3] [--models a,b] [--concurrency 3] [--yes]");
    return;
  }
  const top = Math.floor(readNumber(args, "--top", DEFAULT_TOP));
  const maxCostUsd = readNumber(args, "--max-cost", DEFAULT_MAX_COST_USD);
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
    select: { publicId: true, promptText: true, officialPromptId: true },
  });
  if (!candidate?.officialPromptId) throw new Error("No selected, visible Gallery prompt matches --prompt");
  if (!isCommunityArenaPrompt(candidate.promptText)) throw new Error("Benchmark prompts are generated with batch:generate");

  // any existing row counts, including pending gallery imports, so nothing is replaced
  const existingRows = await prisma.build.findMany({
    where: {
      promptId: candidate.officialPromptId,
      gridSize: ARENA_BUILD_GRID_SIZE,
      palette: ARENA_BUILD_PALETTE,
      mode: ARENA_BUILD_MODE,
    },
    select: { model: { select: { key: true } } },
  });
  const plan = planCommunityModels({
    ranked: await loadRankedModels(),
    costOf: getAverageBenchmarkCostPerBuildUsd as (key: ModelKey) => number | null,
    existing: new Set(existingRows.map((row) => row.model.key)),
    top,
    maxCostUsd,
    explicit,
  });

  const siteUrl = (process.env.MINEBENCH_SITE_URL ?? "https://minebench.ai").replace(/\/+$/, "");
  console.log(`Prompt: ${candidate.promptText}`);
  console.log(`Database: ${galleryDatabaseTarget()}  Import target: ${siteUrl}`);
  console.log(`Already built: ${existingRows.length}`);
  for (const model of plan) {
    const rank = Number.isFinite(model.rank) ? `#${model.rank}` : "unranked";
    console.log(`  ${rank.padStart(9)}  ${MODEL_SLUG[model.key].padEnd(28)} ${formatUsd(model.costUsd)}`);
  }
  const total = plan.reduce((sum, model) => sum + (model.costUsd ?? 0), 0);
  console.log(`Estimated cost: $${total.toFixed(2)} for ${plan.length} build${plan.length === 1 ? "" : "s"}`);
  if (plan.length === 0 || !args.includes("--yes")) {
    if (plan.length > 0) console.log("Plan only. Add --yes to generate and upload.");
    return;
  }

  const outDir = path.join(os.tmpdir(), "minebench-gallery-generate", candidate.publicId);
  fs.mkdirSync(outDir, { recursive: true });
  const failures: string[] = [];
  await runPool(plan, concurrency, async ({ key }) => {
    const modelSlug = MODEL_SLUG[key];
    const job: Job = {
      promptSlug: `community/${candidate.publicId}`,
      promptText: candidate.promptText,
      modelKey: key,
      modelSlug,
      filePath: path.join(outDir, `${modelSlug}.json`),
    };
    console.log(`  → ${modelSlug} generating`);
    const result = await generateVoxelBuild({
      model: getBatchGenerationModel(key, false),
      prompt: candidate.promptText,
      gridSize: ARENA_BUILD_GRID_SIZE,
      palette: ARENA_BUILD_PALETTE,
      maxAttempts: MAX_ATTEMPTS,
      enableTools: true,
      onRetry: (attempt, reason) => console.log(`    ↻ ${modelSlug} retry ${attempt}${reason ? `: ${reason}` : ""}`),
    });
    if (!result.ok) {
      failures.push(`${modelSlug}: ${result.error}`);
      return;
    }
    fs.writeFileSync(job.filePath, JSON.stringify(result.build, null, 2));
    const uploaded = await uploadBuild(job, result.generationTimeMs);
    if (!uploaded.ok) {
      failures.push(`${modelSlug}: ${uploaded.error} (saved at ${job.filePath})`);
      return;
    }
    console.log(`  ✓ ${modelSlug} ${result.blockCount.toLocaleString()} blocks`);
  });

  console.log(`Done: ${plan.length - failures.length}/${plan.length} uploaded`);
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
