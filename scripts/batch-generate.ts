#!/usr/bin/env npx tsx
/**
 * Batch Generate & Upload Script for MineBench
 * 
 * Usage:
 *   pnpm batch:generate                     # Show status of all builds
 *   pnpm batch:generate --upload            # Upload existing builds to prod
 *   pnpm batch:generate --generate          # Generate missing builds
 *   pnpm batch:generate --generate --upload # Generate missing and upload all
 *   pnpm batch:generate --prompt "castle"   # Filter by prompt
 *   pnpm batch:generate --model gemini      # Filter by model
 * 
 * Environment:
 *   Requires .env with OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY
 *   For upload: requires ADMIN_TOKEN
 */

import * as fs from "fs";
import * as path from "path";
import { generateVoxelBuild } from "../lib/ai/generateVoxelBuild";
import { MODEL_CATALOG, ModelKey } from "../lib/ai/modelCatalog";

// load env
import "dotenv/config";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const PROD_URL = "https://minebench.vercel.app";

// all curated prompts with short slugs for filenames
const PROMPT_MAP: Record<string, string> = {
  steampunk: "A steampunk airship with a wooden hull, large brass propellers on each side, a balloon made of patchwork fabric above the deck, hanging ropes and ladders, and a glass-enclosed bridge at the front",
  carrier: "A flying aircraft carrier with a flat deck on top, control tower, planes parked on deck, massive jet engines underneath keeping it aloft, and radar dishes",
  locomotive: "A steam locomotive",
  skyscraper: "A skyscraper",
  treehouse: "A treehouse village: three large treehouses in adjacent trees connected by rope bridges, each house with different architecture (one rustic, one elvish with curved lines, one modern with clean angles), rope ladders down, and lanterns hanging from branches",
  cottage: "A cozy cottage",
  worldtree: "A massive world tree: an enormous trunk with roots visible above ground forming archways, multiple levels of thick branches like platforms, glowing fruit hanging from smaller branches, and vines draping down",
  floating: "A floating island ecosystem: a chunk of earth suspended in air with waterfalls pouring off multiple edges, a small forest on top, exposed roots and rocks hanging underneath, and smaller floating rocks nearby connected by ancient chain bridges",
  shipwreck: "An underwater shipwreck: a wooden galleon on its side on the ocean floor, holes in the hull, coral and seaweed growing on it, treasure chests spilling gold, and fish swimming around",
  phoenix: "A phoenix rising from flames: wings fully spread upward, tail feathers flowing down like fire, head raised to the sky, made of red, orange, and gold blocks with glowstone accents",
  knight: "A knight in armor",
  castle: "A medieval stone castle with curtain walls forming a square, four tall corner towers with battlements, a central keep, a gatehouse with an archway and portcullis, and a surrounding moat with a small drawbridge.",
};

// model key to short filename slug
const MODEL_SLUG: Record<ModelKey, string> = {
  openai_gpt_5_2: "gpt-5-2",
  openai_gpt_5_2_pro: "gpt-5-2-pro",
  openai_gpt_5_2_codex: "gpt-5-2-codex",
  openai_gpt_5_mini: "gpt-5-mini",
  openai_gpt_4_1: "gpt-4-1",
  anthropic_claude_4_5_sonnet: "sonnet",
  anthropic_claude_4_5_opus: "opus",
  gemini_3_0_pro: "gemini-pro",
  gemini_3_0_flash: "gemini-flash",
};

interface Job {
  promptSlug: string;
  promptText: string;
  modelKey: ModelKey;
  modelSlug: string;
  filePath: string;
}

function getJsonPath(promptSlug: string, modelSlug: string): string {
  return path.join(UPLOADS_DIR, promptSlug, `${promptSlug}-${modelSlug}.json`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    generate: args.includes("--generate"),
    upload: args.includes("--upload"),
    promptFilter: args.find((a, i) => args[i - 1] === "--prompt") || null,
    modelFilter: args.find((a, i) => args[i - 1] === "--model") || null,
    help: args.includes("--help") || args.includes("-h"),
  };
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getEnabledModels(): ModelKey[] {
  return MODEL_CATALOG.filter((m) => m.enabled).map((m) => m.key);
}

function buildJobList(promptFilter: string | null, modelFilter: string | null): Job[] {
  const jobs: Job[] = [];
  const models = getEnabledModels();

  for (const [promptSlug, promptText] of Object.entries(PROMPT_MAP)) {
    if (promptFilter && !promptSlug.includes(promptFilter.toLowerCase())) continue;

    for (const modelKey of models) {
      const modelSlug = MODEL_SLUG[modelKey];
      if (modelFilter && !modelSlug.includes(modelFilter.toLowerCase()) && !modelKey.includes(modelFilter.toLowerCase())) continue;

      const filePath = getJsonPath(promptSlug, modelSlug);
      jobs.push({ promptSlug, promptText, modelKey, modelSlug, filePath });
    }
  }

  return jobs;
}

function isEmptyPlaceholder(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content === "{}" || content === "";
}

function getMissingJobs(jobs: Job[]): Job[] {
  return jobs.filter((j) => isEmptyPlaceholder(j.filePath));
}

async function generateAndSave(job: Job): Promise<{ ok: boolean; error?: string; blockCount?: number }> {
  console.log(`  Generating ${job.promptSlug} × ${job.modelSlug}...`);

  const result = await generateVoxelBuild({
    modelKey: job.modelKey,
    prompt: job.promptText,
    gridSize: 256,
    palette: "simple",
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // ensure prompt directory exists
  ensureDir(path.dirname(job.filePath));

  // write the build json
  fs.writeFileSync(job.filePath, JSON.stringify(result.build, null, 2));

  return { ok: true, blockCount: result.blockCount };
}

function getUploadCommand(job: Job): string {
  const encPromptJs = `node -p 'encodeURIComponent(process.argv[1])' "${job.promptText.replace(/'/g, "'\\''")}"`;
  return `cd /Users/alam/GitHub/minebench && set -a && source .env && set +a && PROMPT='${job.promptText.replace(/'/g, "'\\''")}' && ENC_PROMPT="$(${encPromptJs})" && curl -sS -X POST "https://minebench.vercel.app/api/admin/import-build?modelKey=${job.modelKey}&promptText=$ENC_PROMPT&overwrite=1" -H "Authorization: Bearer $ADMIN_TOKEN" --data-binary "@${job.filePath}"`;
}

async function uploadBuild(job: Job): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    return { ok: false, error: "ADMIN_TOKEN not set" };
  }

  const json = fs.readFileSync(job.filePath, "utf-8");
  const url = new URL(`${PROD_URL}/api/admin/import-build`);
  url.searchParams.set("modelKey", job.modelKey);
  url.searchParams.set("promptText", job.promptText);
  url.searchParams.set("overwrite", "1");

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: json,
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: `HTTP ${resp.status}: ${text}` };
  }

  return { ok: true };
}

function printStatus(jobs: Job[]) {
  console.log("\n📊 Current Status by Prompt:\n");

  const promptGroups = new Map<string, Job[]>();
  for (const j of jobs) {
    if (!promptGroups.has(j.promptSlug)) promptGroups.set(j.promptSlug, []);
    promptGroups.get(j.promptSlug)!.push(j);
  }

  for (const [slug, group] of promptGroups) {
    const existing = group.filter((j) => !isEmptyPlaceholder(j.filePath));
    const missing = group.filter((j) => isEmptyPlaceholder(j.filePath));

    console.log(`  ${slug}: ${existing.length}/${group.length} models`);
    if (existing.length > 0) {
      console.log(`    ✅ ${existing.map((j) => j.modelSlug).join(", ")}`);
    }
    if (missing.length > 0) {
      console.log(`    ❌ ${missing.map((j) => j.modelSlug).join(", ")}`);
    }
  }
}

function printUploadCommands(jobs: Job[]) {
  console.log("\n📤 Upload Commands for Existing Builds:\n");
  console.log("# Run these commands to upload all existing builds to production:\n");

  for (const job of jobs) {
    if (!isEmptyPlaceholder(job.filePath)) {
      console.log(`# ${job.promptSlug} × ${job.modelSlug}`);
      console.log(getUploadCommand(job));
      console.log("");
    }
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
MineBench Batch Generate Script

Usage:
  pnpm batch:generate                     # Show status of all builds
  pnpm batch:generate --upload            # Upload existing builds to prod
  pnpm batch:generate --generate          # Generate missing builds
  pnpm batch:generate --generate --upload # Generate missing and upload all
  pnpm batch:generate --prompt castle     # Filter by prompt
  pnpm batch:generate --model gemini      # Filter by model

Options:
  --generate        Generate missing builds (off by default)
  --upload          Upload builds to production
  --prompt <str>    Filter prompts by slug
  --model <str>     Filter models by slug
  --help, -h        Show this help
    `);
    return;
  }

  console.log("🏗️  MineBench Batch Generator\n");

  // ensure base uploads dir exists
  ensureDir(UPLOADS_DIR);

  const allJobs = buildJobList(opts.promptFilter, opts.modelFilter);
  console.log(`📋 Total jobs: ${allJobs.length} (${Object.keys(PROMPT_MAP).length} prompts × ${getEnabledModels().length} models)`);

  if (opts.promptFilter) console.log(`   Filtered by prompt: "${opts.promptFilter}"`);
  if (opts.modelFilter) console.log(`   Filtered by model: "${opts.modelFilter}"`);

  printStatus(allJobs);

  const missing = getMissingJobs(allJobs);
  const existing = allJobs.filter((j) => !isEmptyPlaceholder(j.filePath));
  console.log(`\n🔍 Missing builds: ${missing.length}`);

  // upload existing builds if requested
  if (opts.upload) {
    if (existing.length === 0) {
      console.log("\n📤 No existing builds to upload.");
    } else {
      console.log("\n📤 Uploading existing builds...");
      for (const job of existing) {
        process.stdout.write(`  Uploading ${job.promptSlug} × ${job.modelSlug}...`);
        const result = await uploadBuild(job);
        console.log(result.ok ? " ✅" : ` ❌ ${result.error}`);
      }
    }
  }

  // generate missing builds only if --generate flag is set
  if (opts.generate && missing.length > 0) {
    console.log("\n🚀 Starting generation...\n");

    let success = 0;
    let failed = 0;

    for (const job of missing) {
      const result = await generateAndSave(job);
      if (result.ok) {
        console.log(`    ✅ Saved (${result.blockCount} blocks)`);
        success++;

        if (opts.upload) {
          process.stdout.write(`    📤 Uploading...`);
          const uploadResult = await uploadBuild(job);
          console.log(uploadResult.ok ? " ✅" : ` ❌ ${uploadResult.error}`);
        }
      } else {
        console.log(`    ❌ Failed: ${result.error}`);
        failed++;
      }
    }

    console.log(`\n📊 Results: ${success} succeeded, ${failed} failed`);
  } else if (missing.length > 0 && !opts.generate) {
    console.log("\n💡 Use --generate to generate missing builds.");
  } else if (missing.length === 0) {
    console.log("✨ All builds already exist!");
  }

  if (!opts.upload) {
    printUploadCommands(allJobs);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
