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
 *   pnpm batch:generate --model gemini      # Filter by single model
 *   pnpm batch:generate --model gemini-pro gemini-flash --generate # Multiple models
 *   pnpm batch:generate --prompt astronaut --promptText "An astronaut in a space suit" # Custom prompt text override
 * 
 * Environment:
 *   Requires .env with API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) or OPENROUTER_API_KEY
 *   For upload: requires ADMIN_TOKEN
 */

import * as fs from "fs";
import * as path from "path";
import { gzipSync } from "node:zlib";
import { generateVoxelBuild } from "../lib/ai/generateVoxelBuild";
import { extractBestVoxelBuildJson } from "../lib/ai/jsonExtract";
import { MODEL_CATALOG, ModelKey } from "../lib/ai/modelCatalog";
import { MODEL_SLUG, PROMPT_MAP, listUploadPromptSlugs, readUploadPromptText } from "./uploadsCatalog";

// load env
import "dotenv/config";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const PROD_URL = "https://minebench.vercel.app";

interface Job {
  promptSlug: string;
  promptText: string | null;
  modelKey: ModelKey;
  modelSlug: string;
  filePath: string;
}

function getJsonPath(promptSlug: string, modelSlug: string): string {
  return path.join(UPLOADS_DIR, promptSlug, `${promptSlug}-${modelSlug}.json`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const attemptsRaw = args.find((a, i) => args[i - 1] === "--attempts") || null;
  const attemptsNum = attemptsRaw ? Number(attemptsRaw) : NaN;
  const attempts = Number.isFinite(attemptsNum) ? Math.max(1, Math.floor(attemptsNum)) : 6;
  const concurrencyRaw = args.find((a, i) => args[i - 1] === "--concurrency") || null;
  const concurrencyNum = concurrencyRaw ? Number(concurrencyRaw) : NaN;
  const concurrency = Number.isFinite(concurrencyNum) ? Math.max(1, Math.floor(concurrencyNum)) : 1;

  // collect all values after --model until next flag
  const modelFilters: string[] = [];
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1) {
    for (let i = modelIdx + 1; i < args.length; i++) {
      if (args[i].startsWith("--")) break;
      modelFilters.push(args[i]);
    }
  }

  return {
    generate: args.includes("--generate"),
    upload: args.includes("--upload"),
    overwrite: args.includes("--overwrite"),
    attempts,
    concurrency,
    promptFilter: args.find((a, i) => args[i - 1] === "--prompt") || null,
    modelFilters, // now an array
    promptText: args.find((a, i) => args[i - 1] === "--promptText") || null,
    promptTextFile: args.find((a, i) => args[i - 1] === "--promptTextFile") || null,
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

function getAllPromptSlugs(): string[] {
  const slugs = new Set<string>(Object.keys(PROMPT_MAP));
  for (const slug of listUploadPromptSlugs()) slugs.add(slug);
  return Array.from(slugs).sort();
}

function resolvePromptText(promptSlug: string): string | null {
  const fromCatalog = PROMPT_MAP[promptSlug];
  if (fromCatalog) return fromCatalog;
  const fromUploads = readUploadPromptText(promptSlug);
  if (fromUploads) return fromUploads;
  return null;
}

function buildJobList(
  promptSlugs: string[],
  promptTextBySlug: Map<string, string | null>,
  promptFilter: string | null,
  modelFilters: string[]
): Job[] {
  const jobs: Job[] = [];
  const models = getEnabledModels();

  for (const promptSlug of promptSlugs) {
    if (promptFilter && !promptSlug.includes(promptFilter.toLowerCase())) continue;
    const promptText = promptTextBySlug.get(promptSlug) ?? null;

    for (const modelKey of models) {
      const modelSlug = MODEL_SLUG[modelKey];
      // if model filters provided, check if this model matches any of them
      if (modelFilters.length > 0) {
        const matchesAny = modelFilters.some(
          (f) => modelSlug.includes(f.toLowerCase()) || modelKey.includes(f.toLowerCase())
        );
        if (!matchesAny) continue;
      }

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

async function generateAndSave(job: Job, attempts: number): Promise<{ ok: boolean; error?: string; blockCount?: number }> {
  console.log(`  Generating ${job.promptSlug} × ${job.modelSlug}...`);

  if (!job.promptText) {
    return { ok: false, error: `Missing prompt text for "${job.promptSlug}". Add uploads/${job.promptSlug}/prompt.txt or pass --promptText/--promptTextFile.` };
  }

  const result = await generateVoxelBuild({
    modelKey: job.modelKey,
    prompt: job.promptText,
    gridSize: 256,
    palette: "simple",
    maxAttempts: attempts,
    onRetry: (attempt, reason) => {
      const msg = (reason ?? "").trim();
      if (!msg) return;
      console.log(`    ↻ retry ${attempt}: ${msg}`);
    },
  });

  if (!result.ok) {
    if (result.rawText) {
      // Preserve the raw output for debugging/benchmarking even if validation failed.
      ensureDir(path.dirname(job.filePath));
      const rawPath = job.filePath.endsWith(".json") ? job.filePath.replace(/\.json$/, ".raw.txt") : `${job.filePath}.raw.txt`;
      fs.writeFileSync(rawPath, result.rawText);

      const extracted = extractBestVoxelBuildJson(result.rawText);
      if (extracted) {
        const failedJsonPath = job.filePath.endsWith(".json")
          ? job.filePath.replace(/\.json$/, ".failed.json")
          : `${job.filePath}.failed.json`;
        fs.writeFileSync(failedJsonPath, JSON.stringify(extracted, null, 2));
      }
    }
    return { ok: false, error: result.error };
  }

  // ensure prompt directory exists
  ensureDir(path.dirname(job.filePath));

  // write the build json
  fs.writeFileSync(job.filePath, JSON.stringify(result.build, null, 2));

  return { ok: true, blockCount: result.blockCount };
}

function getUploadCommand(job: Job): string {
  if (!job.promptText) {
    return `# Missing prompt text for "${job.promptSlug}". Add uploads/${job.promptSlug}/prompt.txt or pass --promptText/--promptTextFile.`;
  }
  const encPromptJs = `node -p 'encodeURIComponent(process.argv[1])' "${job.promptText.replace(/'/g, "'\\''")}"`;
  return `cd /Users/alam/GitHub/minebench && set -a && source .env && set +a && PROMPT='${job.promptText.replace(/'/g, "'\\''")}' && ENC_PROMPT="$(${encPromptJs})" && gzip -c "${job.filePath}" | curl -sS -X POST "https://minebench.vercel.app/api/admin/import-build?modelKey=${job.modelKey}&promptText=$ENC_PROMPT&overwrite=1" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -H "Content-Encoding: gzip" --data-binary @-`;
}

async function uploadBuild(job: Job): Promise<{ ok: boolean; error?: string }> {
  if (!job.promptText) {
    return { ok: false, error: `Missing prompt text for "${job.promptSlug}". Add uploads/${job.promptSlug}/prompt.txt or pass --promptText/--promptTextFile.` };
  }

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
    const hasPromptText = group.some((j) => Boolean(j.promptText));
    const existing = group.filter((j) => !isEmptyPlaceholder(j.filePath));
    const missing = group.filter((j) => isEmptyPlaceholder(j.filePath));

    console.log(`  ${slug}: ${existing.length}/${group.length} models${hasPromptText ? "" : " (⚠️ missing prompt text)"}`);
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
  pnpm batch:generate --generate --overwrite # Regenerate even if JSON exists
  pnpm batch:generate --prompt castle     # Filter by prompt
  pnpm batch:generate --model gemini      # Filter by single model
  pnpm batch:generate --model gemini-pro gemini-flash --generate  # Multiple models
  pnpm batch:generate --prompt astronaut --promptText "An astronaut in a space suit"
  pnpm batch:generate --generate --concurrency 4  # Run 4 generations at once

Options:
  --generate        Generate missing builds (off by default)
  --upload          Upload builds to production
  --overwrite       When generating, overwrite existing JSON files
  --attempts <n>    Max attempts per build (default 6)
  --concurrency <n> Number of concurrent generations (default 1)
  --prompt <str>    Filter prompts by slug
  --model <str...>  Filter models by slug (can specify multiple)
  --promptText <s>  Prompt text override (only when filtered to 1 prompt)
  --promptTextFile <path> Prompt text override read from file (only when filtered to 1 prompt)
  --help, -h        Show this help
    `);
    return;
  }

  console.log("🏗️  MineBench Batch Generator\n");

  // ensure base uploads dir exists
  ensureDir(UPLOADS_DIR);

  const promptSlugs = getAllPromptSlugs();
  const promptTextBySlug = new Map<string, string | null>();
  for (const slug of promptSlugs) promptTextBySlug.set(slug, resolvePromptText(slug));

  const filteredPromptSlugs = promptSlugs.filter((slug) =>
    opts.promptFilter ? slug.includes(opts.promptFilter.toLowerCase()) : true
  );

  const promptTextOverride = opts.promptTextFile
    ? (fs.existsSync(opts.promptTextFile) ? fs.readFileSync(opts.promptTextFile, "utf-8").trim() : "")
    : (opts.promptText ?? "").trim();

  if ((opts.promptText || opts.promptTextFile) && filteredPromptSlugs.length !== 1) {
    console.error(
      `\nError: --promptText/--promptTextFile requires filtering to exactly 1 prompt folder.\n` +
        `Matched prompts: ${filteredPromptSlugs.length}\n`
    );
    process.exit(1);
  }

  if (promptTextOverride && filteredPromptSlugs.length === 1) {
    promptTextBySlug.set(filteredPromptSlugs[0], promptTextOverride);
  }

  const allJobs = buildJobList(promptSlugs, promptTextBySlug, opts.promptFilter, opts.modelFilters);
  console.log(`📋 Total jobs: ${allJobs.length} (${promptSlugs.length} prompts × ${getEnabledModels().length} models)`);

  if (opts.promptFilter) console.log(`   Filtered by prompt: "${opts.promptFilter}"`);
  if (opts.modelFilters.length > 0) console.log(`   Filtered by model(s): ${opts.modelFilters.join(", ")}`);

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
  const jobsToGenerate = opts.generate ? (opts.overwrite ? allJobs : missing) : [];
  if (opts.generate && jobsToGenerate.length > 0) {
    console.log(`\n🚀 Starting generation (concurrency ${opts.concurrency})...\n`);

    let success = 0;
    let failed = 0;

    const queue = [...jobsToGenerate];
    let inFlight = 0;
    await new Promise<void>((resolve) => {
      const launchNext = () => {
        while (inFlight < opts.concurrency && queue.length > 0) {
          const job = queue.shift()!;
          inFlight += 1;
          void (async () => {
            const result = await generateAndSave(job, opts.attempts);
            if (result.ok) {
              console.log(`    ✅ Saved (${result.blockCount} blocks)`);
              success++;

              if (opts.upload) {
                process.stdout.write(`    📤 Uploading...`);
                const uploadResult = await uploadBuild(job);
                console.log(uploadResult.ok ? " ✅" : ` ❌ ${uploadResult.error}`);
              }
            } else {
              console.log(`    ❌ Failed after ${opts.attempts} attempts: ${result.error}`);
              failed++;
            }
          })()
            .catch((err) => {
              failed++;
              console.log(`    ❌ Failed after ${opts.attempts} attempts: ${err instanceof Error ? err.message : err}`);
            })
            .finally(() => {
              inFlight -= 1;
              if (queue.length === 0 && inFlight === 0) {
                resolve();
              } else {
                launchNext();
              }
            });
        }
      };
      launchNext();
    });

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
