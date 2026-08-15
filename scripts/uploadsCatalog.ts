import * as fs from "fs";
import * as path from "path";
import { MODEL_CATALOG, type ModelKey } from "../lib/ai/modelCatalog";

export const UPLOADS_DIR = path.join(process.cwd(), "uploads");
export const PROMPT_TEXT_FILENAME = "prompt.txt";
const IGNORED_UPLOAD_DIRS = new Set(["tool-runs", "local"]);

export { BENCHMARK_PROMPT_MAP } from "../lib/benchmark/prompts";
import { BENCHMARK_PROMPT_MAP } from "../lib/benchmark/prompts";

// Add custom prompts here to make them importable by scripts without changing the benchmark cohort.
export const PROMPT_MAP: Record<string, string> = {
  ...BENCHMARK_PROMPT_MAP,
};

// Model key to short filename slug, derived from the catalog
export const MODEL_SLUG = Object.fromEntries(
  MODEL_CATALOG.map((model) => [model.key, model.slug]),
) as Record<ModelKey, string>;

export const MODEL_KEY_BY_SLUG = Object.fromEntries(
  (Object.entries(MODEL_SLUG) as [ModelKey, string][]).map(([key, slug]) => [slug, key])
) as Record<string, ModelKey>;

export function listUploadPromptSlugs(): string[] {
  if (!fs.existsSync(UPLOADS_DIR)) return [];
  const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith("."))
    .filter((name) => !IGNORED_UPLOAD_DIRS.has(name))
    .sort();
}

export function readUploadPromptText(promptSlug: string): string | null {
  const p = path.join(UPLOADS_DIR, promptSlug, PROMPT_TEXT_FILENAME);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf-8").trim();
  return text ? text : null;
}

// For batch generation: include curated prompts, and add/override anything with `uploads/<slug>/prompt.txt`.
export function loadPromptMapFromUploads(): Record<string, string> {
  const merged: Record<string, string> = { ...PROMPT_MAP };
  for (const slug of listUploadPromptSlugs()) {
    const text = readUploadPromptText(slug);
    if (text) merged[slug] = text;
  }
  return merged;
}
