#!/usr/bin/env npx tsx
/**
 * Prompt + Build Import Script for MineBench
 *
 * Imports voxel JSON builds from `uploads/<prompt-slug>/*.json` into the local Prisma database.
 * If the prompt doesn't exist yet, it will be created (active=true).
 *
 * Usage:
 *   pnpm prompt                           # Show importable uploads status
 *   pnpm prompt --init --prompt arcade --text "A classic arcade cabinet with ..."
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
import { getModelByKey, MODEL_CATALOG, ModelKey } from "../lib/ai/modelCatalog";
import { extractBestVoxelBuildJson } from "../lib/ai/jsonExtract";
import { getPalette } from "../lib/blocks/palettes";
import { parseVoxelBuildSpec, validateVoxelBuild } from "../lib/voxel/validate";
import { maxBlocksForGrid } from "../lib/ai/generateVoxelBuild";
import {
  listUploadPromptSlugs,
  MODEL_KEY_BY_SLUG,
  MODEL_SLUG,
  PROMPT_MAP,
  PROMPT_TEXT_FILENAME,
  readUploadPromptText,
  UPLOADS_DIR,
} from "./uploadsCatalog";

type PaletteName = "simple" | "advanced";

type Args = {
  help: boolean;
  init: boolean;
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
    init: argv.includes("--init"),
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

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function initPromptFolder(opts: { promptSlug: string; promptText: string; overwrite: boolean; dryRun: boolean }) {
  const slug = opts.promptSlug;
  if (!slug) throw new Error("Invalid prompt slug (empty after normalization)");

  const promptDir = path.join(UPLOADS_DIR, slug);
  const promptPath = path.join(promptDir, PROMPT_TEXT_FILENAME);
  const promptText = opts.promptText.trim();
  if (!promptText) throw new Error("Prompt text cannot be empty");

  if (opts.dryRun) {
    console.log(`\n[dry-run] would create ${path.join("uploads", slug)}/ and write ${path.join("uploads", slug, PROMPT_TEXT_FILENAME)}`);
    return;
  }

  ensureDir(promptDir);

  if (fs.existsSync(promptPath) && !opts.overwrite) {
    const existing = fs.readFileSync(promptPath, "utf-8").trim();
    if (existing && existing !== promptText) {
      throw new Error(`prompt.txt already exists for "${slug}". Re-run with --overwrite to replace it.`);
    }
  }

  fs.writeFileSync(promptPath, `${promptText}\n`);

  const enabledModels = MODEL_CATALOG.filter((m) => m.enabled).map((m) => m.key);
  for (const modelKey of enabledModels) {
    const modelSlug = MODEL_SLUG[modelKey];
    const filePath = path.join(promptDir, `${slug}-${modelSlug}.json`);
    if (fs.existsSync(filePath)) continue;
    fs.writeFileSync(filePath, "{}\n");
  }
}

function buildJobs(args: Args, promptTextBySlug: Map<string, string | null>) {
  const promptSlugs = listUploadPromptSlugs().filter((slug) => matchesFilter(slug, args.promptFilter));
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
  pnpm prompt --init --prompt arcade --text "A classic arcade cabinet with ..."
  pnpm prompt --import --prompt astronaut --text "An astronaut in a space suit"
  pnpm prompt --import --prompt fighter-jet --text-file uploads/fighter-jet/prompt.txt

Options:
  --init              Create uploads/<slug>/prompt.txt + placeholder JSONs for enabled models
  --import            Import builds into local DB (Prisma)
  --dry-run           Show what would be imported (with --import)
  --overwrite         Overwrite existing builds in DB (and prompt.txt when used with --init)
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

function printStatus(
  promptSlugs: string[],
  promptTextBySlug: Map<string, string | null>,
  jobs: Job[],
  warnings: string[],
  promptFilter: string | null
) {
  console.log("\n📦 Uploads Status\n");
  if (promptSlugs.length === 0) {
    if (promptFilter) {
      console.log(`No matching prompt folders found in ./uploads (filter: "${promptFilter}")`);
    } else {
      console.log("No prompt folders found in ./uploads");
    }
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
      glickoRd: 350,
      glickoVolatility: 0.06,
      conservativeRating: 800,
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

  const rawPromptArg = args.promptFilter?.trim() ?? null;
  const initSlug = rawPromptArg ? slugify(rawPromptArg) : null;
  const initDirExists = initSlug ? fs.existsSync(path.join(UPLOADS_DIR, initSlug)) : false;

  if (args.init) {
    if (!rawPromptArg) {
      console.error("\nError: --init requires --prompt <slug>");
      process.exitCode = 1;
      return;
    }

    const promptText =
      (args.textFile ? readPromptTextFromFile(args.textFile) : args.text?.trim() ?? null) ??
      (initSlug ? PROMPT_MAP[initSlug] ?? null : null);

    if (!promptText) {
      console.error("\nError: Missing prompt text. Provide --text, --text-file, or add it to scripts/uploadsCatalog.ts PROMPT_MAP.");
      process.exitCode = 1;
      return;
    }

    try {
      if (initSlug && initSlug !== rawPromptArg.toLowerCase()) {
        console.log(`\nℹ️  Normalized slug "${rawPromptArg}" -> "${initSlug}"`);
      }
      initPromptFolder({ promptSlug: initSlug ?? rawPromptArg.toLowerCase(), promptText, overwrite: args.overwrite, dryRun: args.dryRun });
      if (!args.dryRun) console.log(`\n✅ Initialized ${path.join("uploads", initSlug ?? rawPromptArg.toLowerCase())}/`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to init prompt folder";
      console.error(`\nError: ${message}`);
      process.exitCode = 1;
      return;
    }
  } else if (args.import && (args.text || args.textFile) && rawPromptArg && initSlug && !initDirExists) {
    // Convenience: if you try to import a brand-new prompt by slug + text, initialize the uploads folder first.
    const promptText = args.textFile ? readPromptTextFromFile(args.textFile) : args.text?.trim() ?? null;
    if (promptText && initSlug === rawPromptArg.toLowerCase()) {
      try {
        initPromptFolder({ promptSlug: initSlug, promptText, overwrite: args.overwrite, dryRun: args.dryRun });
        if (!args.dryRun) console.log(`\n✅ Initialized ${path.join("uploads", initSlug)}/`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to init prompt folder";
        console.error(`\nError: ${message}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const promptTextBySlug = new Map<string, string | null>();
  for (const slug of listUploadPromptSlugs()) {
    const fromFolder = readUploadPromptText(slug);
    const fromCatalog = PROMPT_MAP[slug] ?? null;
    promptTextBySlug.set(slug, fromFolder ?? fromCatalog);
  }

  const { promptSlugs, jobs, warnings } = buildJobs(args, promptTextBySlug);
  printStatus(promptSlugs, promptTextBySlug, jobs, warnings, args.promptFilter);

  if (!args.import) return;

  if (args.text && args.textFile) {
    console.error("\nError: pass only one of --text or --text-file.");
    process.exitCode = 1;
    return;
  }

  if ((args.text || args.textFile) && promptSlugs.length !== 1) {
    if (promptSlugs.length === 0) {
      console.error(
        `\nError: No matching prompt folder found in ./uploads.\n\n` +
          `Create one first:\n` +
          `  pnpm prompt --init --prompt ${args.promptFilter ?? "<slug>"} --text "..."`
      );
    } else {
      console.error(
        "\nError: --text/--text-file can only be used when importing exactly one prompt (use --prompt to narrow it down)."
      );
    }
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

      const spec = parseVoxelBuildSpec(json);
      if (!spec.ok) {
        failed += 1;
        console.error(`❌ ${job.promptSlug} × ${job.modelSlug}: ${spec.error}`);
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
            voxelData: spec.value,
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
            voxelData: spec.value,
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
