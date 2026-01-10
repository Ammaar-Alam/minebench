#!/usr/bin/env npx tsx
/**
 * Prompt + Build Import Script for MineBench
 *
 * Imports voxel JSON builds from `uploads/<prompt-slug>/*.json` into the local Prisma database.
 * If the prompt doesn't exist yet, it will be created (active=true).
 *
 * Usage:
 *   pnpm prompt                           # Show importable uploads status
 *   pnpm prompt --import --prompt astronaut --text "An astronaut in a space suit"
 *   pnpm prompt --import --prompt fighter-jet --text-file uploads/fighter-jet/prompt.txt
 *   pnpm prompt --import --prompt astronaut --overwrite
 *
 * Notes:
 * - Prompt text is required for new prompts. Resolution order:
 *   1) `uploads/<slug>/prompt.txt` if present
 *   2) built-in curated `PROMPT_MAP` (see `scripts/uploadsCatalog.ts`)
 *   3) `--text` / `--text-file` (only allowed when importing a single prompt)
 */

import * as fs from "fs";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { getModelByKey, ModelKey } from "../lib/ai/modelCatalog";
import { extractBestVoxelBuildJson } from "../lib/ai/jsonExtract";
import { getPalette } from "../lib/blocks/palettes";
import { validateVoxelBuild } from "../lib/voxel/validate";
import { maxBlocksForGrid } from "../lib/ai/generateVoxelBuild";
import { MODEL_KEY_BY_SLUG, MODEL_SLUG, PROMPT_MAP } from "./uploadsCatalog";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const PROMPT_TEXT_FILENAME = "prompt.txt";

type PaletteName = "simple" | "advanced";

type Args = {
  help: boolean;
  import: boolean;
  dryRun: boolean;
  overwrite: boolean;
  promptFilter: string | null;
  modelFilter: string | null;
  text: string | null;
  textFile: string | null;
  gridSize: 64 | 256 | 512;
  palette: PaletteName;
  mode: string;
};

type Job = {
  promptSlug: string;
  promptText: string;
  modelKey: ModelKey;
  modelSlug: string;
  filePath: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);

  const valueAfter = (flag: string) => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return null;
    return argv[idx + 1] ?? null;
  };

  const gridSizeRaw = valueAfter("--gridSize") ?? "256";
  const gridSizeNum = Number(gridSizeRaw);
  const gridSize = gridSizeNum === 64 || gridSizeNum === 256 || gridSizeNum === 512 ? gridSizeNum : 256;

  const paletteRaw = (valueAfter("--palette") ?? "simple").trim().toLowerCase();
  const palette = paletteRaw === "advanced" ? "advanced" : "simple";

  const mode = (valueAfter("--mode") ?? "precise").trim();

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    import: argv.includes("--import"),
    dryRun: argv.includes("--dry-run"),
    overwrite: argv.includes("--overwrite"),
    promptFilter: valueAfter("--prompt"),
    modelFilter: valueAfter("--model"),
    text: valueAfter("--text"),
    textFile: valueAfter("--text-file"),
    gridSize,
    palette,
    mode: mode || "precise",
  };
}

function ensureDir(dir: string) {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
}

function listPromptSlugs(): string[] {
  if (!fs.existsSync(UPLOADS_DIR)) return [];
  const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

function readPromptTextFromFolder(promptSlug: string): string | null {
  const p = path.join(UPLOADS_DIR, promptSlug, PROMPT_TEXT_FILENAME);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf-8").trim();
  return text ? text : null;
}

function readPromptTextFromFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf-8").trim();
  return text ? text : null;
}

function isEmptyPlaceholder(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content === "{}" || content === "";
}

const MODEL_SLUGS_DESC = Object.values(MODEL_SLUG).sort((a, b) => b.length - a.length);

function detectModelSlugFromFilename(fileName: string): string | null {
  const base = path.basename(fileName, ".json");
  for (const slug of MODEL_SLUGS_DESC) {
    if (base === slug) return slug;
    if (base.endsWith(`-${slug}`)) return slug;
  }
  return null;
}

function matchesFilter(value: string, filter: string | null): boolean {
  if (!filter) return true;
  return value.toLowerCase().includes(filter.toLowerCase());
}

function buildJobs(args: Args, promptTextBySlug: Map<string, string | null>) {
  const promptSlugs = listPromptSlugs().filter((slug) => matchesFilter(slug, args.promptFilter));
  const jobs: Job[] = [];
  const warnings: string[] = [];

  for (const promptSlug of promptSlugs) {
    const promptDir = path.join(UPLOADS_DIR, promptSlug);
    const promptText = promptTextBySlug.get(promptSlug) ?? null;

    if (!fs.existsSync(promptDir)) continue;
    const files = fs
      .readdirSync(promptDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort();

    const seenByModelKey = new Set<string>();

    for (const fileName of files) {
      const filePath = path.join(promptDir, fileName);
      if (isEmptyPlaceholder(filePath)) continue;

      const modelSlug = detectModelSlugFromFilename(fileName);
      if (!modelSlug) {
        warnings.push(`Unknown model slug in filename: ${path.join("uploads", promptSlug, fileName)}`);
        continue;
      }

      const modelKey = MODEL_KEY_BY_SLUG[modelSlug];
      if (!modelKey) {
        warnings.push(`Unmapped model slug "${modelSlug}" in: ${path.join("uploads", promptSlug, fileName)}`);
        continue;
      }

      if (!matchesFilter(modelSlug, args.modelFilter) && !matchesFilter(modelKey, args.modelFilter)) continue;

      const dedupeKey = `${promptSlug}:${modelKey}`;
      if (seenByModelKey.has(dedupeKey)) {
        warnings.push(`Duplicate model build for ${promptSlug} × ${modelSlug}; skipping ${path.join("uploads", promptSlug, fileName)}`);
        continue;
      }
      seenByModelKey.add(dedupeKey);

      jobs.push({
        promptSlug,
        promptText: promptText ?? "",
        modelKey,
        modelSlug,
        filePath,
      });
    }
  }

  return { promptSlugs, jobs, warnings };
}

function printHelp() {
  console.log(`
MineBench Prompt Import Script

Usage:
  pnpm prompt
  pnpm prompt --import --prompt astronaut --text "An astronaut in a space suit"
  pnpm prompt --import --prompt fighter-jet --text-file uploads/fighter-jet/prompt.txt

Options:
  --import            Import builds into local DB (Prisma)
  --dry-run           Show what would be imported (with --import)
  --overwrite         Overwrite existing builds in DB
  --prompt <slug>     Filter prompt folders by substring (e.g. "castle")
  --model <str>       Filter models by slug or key substring (e.g. "gemini", "sonnet")
  --text <prompt>     Prompt text (only allowed if importing exactly one prompt)
  --text-file <path>  Read prompt text from a file (only allowed if importing exactly one prompt)
  --gridSize <n>      64 | 256 | 512 (default 256)
  --palette <name>    simple | advanced (default simple)
  --mode <str>        Build mode string (default "precise")
  --help, -h          Show help

Prompt text resolution order:
  1) uploads/<slug>/prompt.txt
  2) scripts/uploadsCatalog.ts PROMPT_MAP
  3) --text / --text-file (single prompt only)
`);
}

function printStatus(promptSlugs: string[], promptTextBySlug: Map<string, string | null>, jobs: Job[], warnings: string[]) {
  console.log("\n📦 Uploads Status\n");
  if (promptSlugs.length === 0) {
    console.log("No prompt folders found in ./uploads");
    return;
  }

  const jobsByPrompt = new Map<string, Job[]>();
  for (const j of jobs) {
    const list = jobsByPrompt.get(j.promptSlug) ?? [];
    list.push(j);
    jobsByPrompt.set(j.promptSlug, list);
  }

  for (const slug of promptSlugs) {
    const promptText = promptTextBySlug.get(slug) ?? null;
    const list = jobsByPrompt.get(slug) ?? [];
    const models = list.map((j) => j.modelSlug).sort();

    const promptLabel = promptText ? "✅ prompt text" : "⚠️ prompt text missing";
    console.log(`  ${slug}: ${models.length} builds (${promptLabel})`);
    if (models.length > 0) console.log(`    models: ${models.join(", ")}`);
    if (!promptText && models.length > 0) {
      console.log(`    add uploads/${slug}/prompt.txt or run: pnpm prompt --import --prompt ${slug} --text "..."`);
    }
  }

  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings.slice(0, 20)) console.log(`  - ${w}`);
    if (warnings.length > 20) console.log(`  - (+${warnings.length - 20} more)`);
  }
}

async function upsertBaselineModel() {
  await prisma.model.upsert({
    where: { key: "baseline" },
    create: {
      key: "baseline",
      provider: "baseline",
      modelId: "baseline",
      displayName: "Baseline",
      enabled: false,
      isBaseline: true,
      eloRating: 1500,
    },
    update: {},
  });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  ensureDir(UPLOADS_DIR);

  const promptTextBySlug = new Map<string, string | null>();
  for (const slug of listPromptSlugs()) {
    const fromFolder = readPromptTextFromFolder(slug);
    const fromCatalog = PROMPT_MAP[slug] ?? null;
    promptTextBySlug.set(slug, fromFolder ?? fromCatalog);
  }

  const { promptSlugs, jobs, warnings } = buildJobs(args, promptTextBySlug);
  printStatus(promptSlugs, promptTextBySlug, jobs, warnings);

  if (!args.import) return;

  if (args.text && args.textFile) {
    console.error("\nError: pass only one of --text or --text-file.");
    process.exitCode = 1;
    return;
  }

  if ((args.text || args.textFile) && promptSlugs.length !== 1) {
    console.error("\nError: --text/--text-file can only be used when importing exactly one prompt (use --prompt to narrow it down).");
    process.exitCode = 1;
    return;
  }

  if (promptSlugs.length === 1) {
    const slug = promptSlugs[0];
    const overrideText = args.textFile ? readPromptTextFromFile(args.textFile) : args.text?.trim() ?? null;
    if (overrideText) promptTextBySlug.set(slug, overrideText);
  }

  const missingPromptText = promptSlugs.filter((slug) => {
    const t = promptTextBySlug.get(slug);
    return !t || !t.trim();
  });

  if (missingPromptText.length > 0) {
    console.error("\nError: Missing prompt text for:");
    for (const slug of missingPromptText) {
      console.error(`  - uploads/${slug}/ (add prompt.txt or pass --text/--text-file)`);
    }
    process.exitCode = 1;
    return;
  }

  const gridSize = args.gridSize;
  const paletteDefs = getPalette(args.palette);
  const maxBlocks = maxBlocksForGrid(gridSize);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  const modelCache = new Map<ModelKey, { id: string; key: string; isBaseline: boolean }>();
  const promptCache = new Map<string, { id: string }>();

  if (!args.dryRun) {
    await upsertBaselineModel();
  }

  for (const promptSlug of promptSlugs) {
    const promptText = promptTextBySlug.get(promptSlug)!.trim();

    if (args.dryRun) {
      const promptJobs = jobs.filter((j) => j.promptSlug === promptSlug);
      console.log(`\n[dry-run] would upsert prompt "${promptText}" and import ${promptJobs.length} builds`);
      continue;
    }

    const prompt =
      promptCache.get(promptText) ??
      (await prisma.prompt.upsert({
        where: { text: promptText },
        create: { text: promptText, active: true },
        update: { active: true },
        select: { id: true },
      }));
    promptCache.set(promptText, prompt);

    const promptJobs = jobs.filter((j) => j.promptSlug === promptSlug);
    for (const job of promptJobs) {
      const modelEntry = getModelByKey(job.modelKey);
      const model =
        modelCache.get(job.modelKey) ??
        (await prisma.model.upsert({
          where: { key: modelEntry.key },
          create: {
            key: modelEntry.key,
            provider: modelEntry.provider,
            modelId: modelEntry.modelId,
            displayName: modelEntry.displayName,
            enabled: true,
            isBaseline: false,
          },
          update: {
            provider: modelEntry.provider,
            modelId: modelEntry.modelId,
            displayName: modelEntry.displayName,
            enabled: true,
          },
          select: { id: true, key: true, isBaseline: true },
        }));
      modelCache.set(job.modelKey, model);

      if (model.isBaseline) {
        console.error(`Skipping baseline model build: ${job.modelKey}`);
        skipped += 1;
        continue;
      }

      let json: unknown;
      try {
        const raw = fs.readFileSync(job.filePath, "utf-8");
        try {
          json = JSON.parse(raw);
        } catch {
          const extracted = extractBestVoxelBuildJson(raw);
          if (!extracted) throw new Error("Could not extract JSON from file contents");
          json = extracted;
        }
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : "Failed to read/parse JSON";
        console.error(`❌ ${job.promptSlug} × ${job.modelSlug}: ${message}`);
        continue;
      }

      const validated = validateVoxelBuild(json, {
        gridSize,
        palette: paletteDefs,
        maxBlocks,
      });
      if (!validated.ok) {
        failed += 1;
        console.error(`❌ ${job.promptSlug} × ${job.modelSlug}: ${validated.error}`);
        continue;
      }

      const blockCount = validated.value.build.blocks.length;

      const existing = await prisma.build.findFirst({
        where: {
          promptId: prompt.id,
          modelId: model.id,
          gridSize,
          palette: args.palette,
          mode: args.mode,
        },
        select: { id: true },
      });

      if (existing && !args.overwrite) {
        skipped += 1;
        continue;
      }

      if (existing) {
        await prisma.build.update({
          where: { id: existing.id },
          data: {
            voxelData: validated.value.build,
            blockCount,
            generationTimeMs: 0,
          },
        });
        updated += 1;
      } else {
        await prisma.build.create({
          data: {
            promptId: prompt.id,
            modelId: model.id,
            gridSize,
            palette: args.palette,
            mode: args.mode,
            voxelData: validated.value.build,
            blockCount,
            generationTimeMs: 0,
          },
        });
        created += 1;
      }

      if (validated.value.warnings.length > 0) {
        console.log(`⚠️  ${job.promptSlug} × ${job.modelSlug}: ${validated.value.warnings.join("; ")}`);
      }
    }
  }

  if (!args.dryRun) {
    await prisma.$disconnect();
  }

  console.log("\n✅ Import complete");
  console.log(`  created: ${created}`);
  console.log(`  updated: ${updated}`);
  console.log(`  skipped: ${skipped}`);
  console.log(`  failed:  ${failed}`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
