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
import { gzipSync } from "node:zlib";
import { generateVoxelBuild } from "../lib/ai/generateVoxelBuild";
import { MODEL_CATALOG, ModelKey } from "../lib/ai/modelCatalog";
import { loadPromptMapFromUploads, MODEL_SLUG } from "./uploadsCatalog";

// load env
import "dotenv/config";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const PROD_URL = "https://minebench.vercel.app";

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

function buildJobList(promptMap: Record<string, string>, promptFilter: string | null, modelFilter: string | null): Job[] {
  const jobs: Job[] = [];
  const models = getEnabledModels();

  for (const [promptSlug, promptText] of Object.entries(promptMap)) {
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
  return `cd /Users/alam/GitHub/minebench && set -a && source .env && set +a && PROMPT='${job.promptText.replace(/'/g, "'\\''")}' && ENC_PROMPT="$(${encPromptJs})" && gzip -c "${job.filePath}" | curl -sS -X POST "https://minebench.vercel.app/api/admin/import-build?modelKey=${job.modelKey}&promptText=$ENC_PROMPT&overwrite=1" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -H "Content-Encoding: gzip" --data-binary @-`;
}

async function uploadBuild(job: Job): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    return { ok: false, error: "ADMIN_TOKEN not set" };
  }

  const jsonBytes = fs.readFileSync(job.filePath);
  const gzipped = gzipSync(jsonBytes);
  const url = new URL(`${PROD_URL}/api/admin/import-build`);
  url.searchParams.set("modelKey", job.modelKey);
  url.searchParams.set("promptText", job.promptText);
  url.searchParams.set("overwrite", "1");

  async function doUpload(opts: { body: Uint8Array<ArrayBufferLike>; headers: Record<string, string> }) {
    // Next's `fetch` typings only accept non-shared `ArrayBuffer` views, so coerce the buffer type
    // without copying (Node Buffers use ArrayBuffer under the hood).
    const body = new Uint8Array(opts.body.buffer as ArrayBuffer, opts.body.byteOffset, opts.body.byteLength);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: opts.headers,
      body,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  }

  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const gzipAttempt = await doUpload({
    headers: { ...baseHeaders, "Content-Encoding": "gzip" },
    body: gzipped,
  });

  if (gzipAttempt.ok) return { ok: true };

  // If prod hasn't been deployed with gzip support yet, it'll try to parse gzipped bytes as text,
  // resulting in a "no JSON object found" error. Retry identity once to provide a clearer error.
  const looksLikeGzipUnsupported =
    gzipAttempt.status === 415 || (gzipAttempt.status === 400 && gzipAttempt.text.includes("Could not find a valid JSON object"));

  if (looksLikeGzipUnsupported) {
    const identityAttempt = await doUpload({ headers: baseHeaders, body: jsonBytes });
    if (identityAttempt.ok) return { ok: true };
    if (identityAttempt.status === 413) {
      return {
        ok: false,
        error:
          `HTTP 413: ${identityAttempt.text}\n\n` +
          `Your client is sending gzip, but production doesn't appear to be decoding it yet. Deploy the updated ` +
          `/api/admin/import-build route (gzip support) and retry.`,
      };
    }
    return { ok: false, error: `HTTP ${identityAttempt.status}: ${identityAttempt.text}` };
  }

  return { ok: false, error: `HTTP ${gzipAttempt.status}: ${gzipAttempt.text}` };
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

  const promptMap = loadPromptMapFromUploads();
  const allJobs = buildJobList(promptMap, opts.promptFilter, opts.modelFilter);
  console.log(`📋 Total jobs: ${allJobs.length} (${Object.keys(promptMap).length} prompts × ${getEnabledModels().length} models)`);

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
