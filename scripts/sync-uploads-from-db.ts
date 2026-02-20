#!/usr/bin/env npx tsx
/**
 * Sync local uploads/ JSON files from builds currently stored in the database.
 *
 * Default scope matches arena builds:
 *   gridSize=256, palette=simple, mode=precise, model.isBaseline=false
 *
 * Usage:
 *   pnpm uploads:sync
 *   pnpm uploads:sync --dry-run
 *   pnpm uploads:sync --prompt castle skyscraper
 *   pnpm uploads:sync --model gemini sonnet
 *   pnpm uploads:sync --gridSize 64 --palette advanced --mode precise
 */

import * as fs from "node:fs";
import * as path from "node:path";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { resolveBuildPayload } from "../lib/storage/buildPayload";
import { extractBestVoxelBuildJson } from "../lib/ai/jsonExtract";
import { parseVoxelBuildSpec } from "../lib/voxel/validate";
import {
  listUploadPromptSlugs,
  MODEL_SLUG,
  PROMPT_MAP,
  PROMPT_TEXT_FILENAME,
  readUploadPromptText,
  UPLOADS_DIR,
} from "./uploadsCatalog";

type Args = {
  help: boolean;
  dryRun: boolean;
  promptFilters: string[];
  modelFilters: string[];
  gridSize: 64 | 256 | 512;
  palette: "simple" | "advanced";
  mode: string;
};

type BuildMeta = {
  id: string;
  promptText: string;
  modelKey: string;
  modelDisplayName: string;
  voxelData: unknown | null;
  voxelStorageBucket: string | null;
  voxelStoragePath: string | null;
  voxelStorageEncoding: string | null;
};

type BuildAction = "created" | "updated" | "unchanged" | "failed";

type PromptRollup = {
  promptSlug: string;
  promptText: string;
  modelsSelected: number;
  promptFileSynced: boolean;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
};

type DbAttempt = {
  source: string;
  url: string;
};

function collectFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    let j = i + 1;
    while (j < args.length && !args[j].startsWith("--")) {
      values.push(args[j]);
      j += 1;
    }
    i = j - 1;
  }
  return values;
}

function normalizePromptText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function slugify(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || "prompt";
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function compactErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const firstLine = err.message.split("\n")[0]?.trim();
    if (firstLine) return firstLine;
    return err.name || "Unknown error";
  }
  return String(err);
}

function describeDbTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

function buildDbAttempts(): DbAttempt[] {
  const attempts: DbAttempt[] = [];
  const seen = new Set<string>();

  const pushUnique = (source: string, raw: string | undefined) => {
    const url = (raw ?? "").trim();
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    attempts.push({ source, url });
  };

  // Optional explicit override for this script.
  pushUnique("MINEBENCH_SYNC_DATABASE_URL", process.env.MINEBENCH_SYNC_DATABASE_URL);
  // Normal runtime URL first.
  pushUnique("DATABASE_URL", process.env.DATABASE_URL);
  // Fallback to direct connection if pooler/runtime URL is unreachable.
  pushUnique("DIRECT_URL", process.env.DIRECT_URL);

  return attempts;
}

async function connectPrismaForSync(): Promise<{
  prisma: PrismaClient;
  source: string;
  target: string;
}> {
  const attempts = buildDbAttempts();
  if (attempts.length === 0) {
    throw new Error(
      "No database URL found. Set DATABASE_URL (or MINEBENCH_SYNC_DATABASE_URL).",
    );
  }

  const failures: string[] = [];
  for (const attempt of attempts) {
    const prisma = new PrismaClient({
      datasources: { db: { url: attempt.url } },
      log: ["error"],
    });

    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      return {
        prisma,
        source: attempt.source,
        target: describeDbTarget(attempt.url),
      };
    } catch (err) {
      failures.push(
        `${attempt.source} (${describeDbTarget(attempt.url)}): ${compactErrorMessage(err)}`,
      );
      await prisma.$disconnect().catch(() => {});
    }
  }

  throw new Error(
    `Unable to connect to database using any configured URL.\n` +
      failures.map((f) => `- ${f}`).join("\n") +
      `\n\nTry:\n` +
      `1) verify network/VPN/firewall access to Supabase\n` +
      `2) run with override: MINEBENCH_SYNC_DATABASE_URL=\"$DIRECT_URL\" pnpm uploads:sync --dry-run`,
  );
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const valueAfter = (flag: string) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? (argv[idx + 1] ?? null) : null;
  };

  const gridSizeRaw = Number(valueAfter("--gridSize") ?? "256");
  const gridSize = gridSizeRaw === 64 || gridSizeRaw === 256 || gridSizeRaw === 512 ? gridSizeRaw : 256;

  const paletteRaw = (valueAfter("--palette") ?? "simple").trim().toLowerCase();
  const palette = paletteRaw === "advanced" ? "advanced" : "simple";

  const mode = (valueAfter("--mode") ?? "precise").trim() || "precise";

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    dryRun: argv.includes("--dry-run"),
    promptFilters: collectFlagValues(argv, "--prompt").map((v) => v.trim()).filter(Boolean),
    modelFilters: collectFlagValues(argv, "--model").map((v) => v.trim()).filter(Boolean),
    gridSize,
    palette,
    mode,
  };
}

function printHelp() {
  console.log(`
Sync uploads/ from DB builds

Usage:
  pnpm uploads:sync
  pnpm uploads:sync --dry-run
  pnpm uploads:sync --prompt castle skyscraper
  pnpm uploads:sync --model gemini sonnet
  pnpm uploads:sync --gridSize 64 --palette advanced --mode precise

Options:
  --dry-run            Print planned writes without changing files
  --prompt <str...>    Filter prompts by slug/text (multiple allowed)
  --model <str...>     Filter models by key/slug/display name (multiple allowed)
  --gridSize <n>       64 | 256 | 512 (default 256)
  --palette <name>     simple | advanced (default simple)
  --mode <name>        Build mode (default precise)
  --help, -h           Show help

Notes:
  - This script creates/updates prompt folders and prompt.txt as needed.
  - It overwrites synced JSON files with DB payloads.
  - Storage-backed builds require SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
`);
}

function matchesAny(value: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const lower = value.toLowerCase();
  return filters.some((f) => lower.includes(f.toLowerCase()));
}

function canonicalBuildJson(raw: string): string | null {
  const extracted = extractBestVoxelBuildJson(raw);
  if (!extracted) return null;
  const parsed = parseVoxelBuildSpec(extracted);
  if (!parsed.ok) return null;
  return JSON.stringify(parsed.value);
}

function groupByPromptText(metas: BuildMeta[]): Array<{ promptText: string; builds: BuildMeta[] }> {
  const grouped = new Map<string, { promptText: string; builds: BuildMeta[] }>();
  for (const meta of metas) {
    const key = normalizePromptText(meta.promptText);
    const existing = grouped.get(key);
    if (existing) {
      existing.builds.push(meta);
      continue;
    }
    grouped.set(key, { promptText: meta.promptText, builds: [meta] });
  }

  return Array.from(grouped.values()).sort((a, b) => a.promptText.localeCompare(b.promptText));
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  const { prisma, source, target } = await connectPrismaForSync();

  try {
    console.log("🔄 MineBench DB → uploads sync\n");
    console.log(
      `Scope: gridSize=${args.gridSize}, palette=${args.palette}, mode=${args.mode}${args.dryRun ? " (dry-run)" : ""}`,
    );
    console.log(`DB: ${source} (${target})`);
    if (args.promptFilters.length > 0) {
      console.log(`Prompt filters: ${args.promptFilters.join(", ")}`);
    }
    if (args.modelFilters.length > 0) {
      console.log(`Model filters: ${args.modelFilters.join(", ")}`);
    }

    ensureDir(UPLOADS_DIR);

    const existingPromptSlugs = listUploadPromptSlugs();
    const usedSlugs = new Set<string>([...existingPromptSlugs, ...Object.keys(PROMPT_MAP)]);
    const promptSlugByNormalizedText = new Map<string, string>();

    for (const [slug, text] of Object.entries(PROMPT_MAP)) {
      promptSlugByNormalizedText.set(normalizePromptText(text), slug);
    }
    for (const slug of existingPromptSlugs) {
      const text = readUploadPromptText(slug);
      if (!text) continue;
      promptSlugByNormalizedText.set(normalizePromptText(text), slug);
    }

    const buildRows = await prisma.build.findMany({
      where: {
        gridSize: args.gridSize,
        palette: args.palette,
        mode: args.mode,
        model: { isBaseline: false },
      },
      select: {
        id: true,
        prompt: { select: { text: true } },
        model: { select: { key: true, displayName: true } },
        voxelData: true,
        voxelStorageBucket: true,
        voxelStoragePath: true,
        voxelStorageEncoding: true,
      },
    });

    const buildMeta: BuildMeta[] = buildRows
      .map((row) => ({
        id: row.id,
        promptText: row.prompt.text,
        modelKey: row.model.key,
        modelDisplayName: row.model.displayName,
        voxelData: row.voxelData,
        voxelStorageBucket: row.voxelStorageBucket,
        voxelStoragePath: row.voxelStoragePath,
        voxelStorageEncoding: row.voxelStorageEncoding,
      }))
      .sort((a, b) => {
        const promptCmp = a.promptText.localeCompare(b.promptText);
        if (promptCmp !== 0) return promptCmp;
        return a.modelDisplayName.localeCompare(b.modelDisplayName);
      });

    if (buildMeta.length === 0) {
      console.log("\nNo builds found in DB for the selected scope.");
      return;
    }

    const promptGroups = groupByPromptText(buildMeta);

    let promptsSelected = 0;
    let selectedBuilds = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    let promptFilesUpdated = 0;

    for (const promptGroup of promptGroups) {
      const normalizedText = normalizePromptText(promptGroup.promptText);
      let promptSlug = promptSlugByNormalizedText.get(normalizedText) ?? null;
      if (!promptSlug) {
        const base = slugify(promptGroup.promptText).slice(0, 56);
        let candidate = base || "prompt";
        let suffix = 2;
        while (usedSlugs.has(candidate)) {
          candidate = `${base}-${suffix}`;
          suffix += 1;
        }
        promptSlug = candidate;
        usedSlugs.add(promptSlug);
        promptSlugByNormalizedText.set(normalizedText, promptSlug);
      }

      const promptFilterPass =
        args.promptFilters.length === 0 ||
        args.promptFilters.some(
          (filter) =>
            promptSlug.toLowerCase().includes(filter.toLowerCase()) ||
            promptGroup.promptText.toLowerCase().includes(filter.toLowerCase()),
        );
      if (!promptFilterPass) continue;

      const selectedModels = promptGroup.builds
        .map((meta) => ({
          meta,
          modelSlug: MODEL_SLUG[meta.modelKey as keyof typeof MODEL_SLUG] ?? slugify(meta.modelKey),
        }))
        .filter(({ meta, modelSlug }) => {
          return (
            args.modelFilters.length === 0 ||
            matchesAny(meta.modelKey, args.modelFilters) ||
            matchesAny(meta.modelDisplayName, args.modelFilters) ||
            matchesAny(modelSlug, args.modelFilters)
          );
        })
        .sort((a, b) => a.modelSlug.localeCompare(b.modelSlug));
      if (selectedModels.length === 0) continue;

      promptsSelected += 1;
      selectedBuilds += selectedModels.length;

      const promptDir = path.join(UPLOADS_DIR, promptSlug);
      const promptPath = path.join(promptDir, PROMPT_TEXT_FILENAME);
      const promptNeedsWrite =
        !fs.existsSync(promptPath) ||
        fs.readFileSync(promptPath, "utf-8").trim() !== promptGroup.promptText.trim();
      let promptSynced = false;

      if (promptNeedsWrite) {
        if (!args.dryRun) {
          ensureDir(promptDir);
          fs.writeFileSync(promptPath, `${promptGroup.promptText.trim()}\n`);
        }
        promptFilesUpdated += 1;
        promptSynced = true;
      }
      ensureDir(promptDir);

      const rollup: PromptRollup = {
        promptSlug,
        promptText: promptGroup.promptText,
        modelsSelected: selectedModels.length,
        promptFileSynced: promptSynced,
        created: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
      };
      const promptErrors: string[] = [];

      for (const { meta, modelSlug } of selectedModels) {
        const payloadSource = {
          voxelData: meta.voxelData,
          voxelStorageBucket: meta.voxelStorageBucket,
          voxelStoragePath: meta.voxelStoragePath,
          voxelStorageEncoding: meta.voxelStorageEncoding,
        };

        try {
          const payload = await resolveBuildPayload(payloadSource);
          const parsed = parseVoxelBuildSpec(payload);
          if (!parsed.ok) {
            rollup.failed += 1;
            failed += 1;
            promptErrors.push(`${modelSlug}: invalid build payload (${parsed.error})`);
            continue;
          }

          const outPath = path.join(promptDir, `${promptSlug}-${modelSlug}.json`);
          const nextCanonical = JSON.stringify(parsed.value);
          const nextPretty = `${JSON.stringify(parsed.value, null, 2)}\n`;
          const prevRaw = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf-8") : null;
          const prevCanonical = prevRaw == null ? null : canonicalBuildJson(prevRaw);
          const action: BuildAction =
            prevCanonical === nextCanonical
              ? "unchanged"
              : prevRaw == null
                ? "created"
                : "updated";

          if (action === "unchanged") {
            rollup.unchanged += 1;
            unchanged += 1;
            continue;
          }

          if (!args.dryRun) {
            fs.writeFileSync(outPath, nextPretty);
          }

          if (action === "created") {
            rollup.created += 1;
            created += 1;
          } else if (action === "updated") {
            rollup.updated += 1;
            updated += 1;
          }
        } catch (err) {
          rollup.failed += 1;
          failed += 1;
          promptErrors.push(`${modelSlug}: ${compactErrorMessage(err)}`);
        }
      }

      const promptSyncLabel = rollup.promptFileSynced
        ? args.dryRun
          ? "prompt.txt would sync"
          : "prompt.txt synced"
        : "prompt.txt unchanged";
      console.log(
        `  ${rollup.promptSlug}: ${rollup.modelsSelected} models | created ${rollup.created} | updated ${rollup.updated} | unchanged ${rollup.unchanged} | ${promptSyncLabel}${rollup.failed > 0 ? ` | failed ${rollup.failed}` : ""}`,
      );
      if (promptErrors.length > 0) {
        for (const err of promptErrors.slice(0, 5)) {
          console.log(`    - ${err}`);
        }
        if (promptErrors.length > 5) {
          console.log(`    - (+${promptErrors.length - 5} more errors)`);
        }
      }
    }

    console.log("\n📊 Sync summary");
    console.log(`  Prompts in scope: ${promptGroups.length}`);
    console.log(`  Prompts selected: ${promptsSelected}`);
    console.log(`  DB builds in scope: ${buildMeta.length}`);
    console.log(`  Selected builds: ${selectedBuilds}`);
    console.log(`  Build files created: ${created}`);
    console.log(`  Build files updated: ${updated}`);
    console.log(`  Build files unchanged: ${unchanged}`);
    console.log(`  prompt.txt ${args.dryRun ? "would sync" : "synced"}: ${promptFilesUpdated}`);
    console.log(`  Failed: ${failed}`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
