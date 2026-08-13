import * as fs from "fs";
import * as path from "path";
import { MODEL_CATALOG, type ModelKey } from "../lib/ai/modelCatalog";

export const UPLOADS_DIR = path.join(process.cwd(), "uploads");
export const PROMPT_TEXT_FILENAME = "prompt.txt";
const IGNORED_UPLOAD_DIRS = new Set(["tool-runs", "local"]);

// The fixed prompt cohort used to publish model-level benchmark metrics.
export const BENCHMARK_PROMPT_MAP: Record<string, string> = {
  arcade:
    "A classic arcade cabinet with a joystick and three buttons on the control panel, a screen showing simple graphics, coin slot on the front, and artwork on the sides",
  astronaut: "An astronaut",
  steampunk:
    "A steampunk airship with a wooden hull, large brass propellers on each side, a balloon made of patchwork fabric above the deck, hanging ropes and ladders, and a glass-enclosed bridge at the front",
  carrier:
    "A flying aircraft carrier with a flat deck on top, control tower, planes parked on deck, massive jet engines underneath keeping it aloft, and radar dishes",
  locomotive: "A steam locomotive",
  skyscraper: "A skyscraper",
  treehouse:
    "A treehouse village: three large treehouses in adjacent trees connected by rope bridges, each house with different architecture (one rustic, one elvish with curved lines, one modern with clean angles), rope ladders down, and lanterns hanging from branches",
  cottage: "A cozy cottage",
  worldtree:
    "A massive world tree: an enormous trunk with roots visible above ground forming archways, multiple levels of thick branches like platforms, glowing fruit hanging from smaller branches, and vines draping down",
  "fighter-jet": "A fighter jet",
  floating:
    "A floating island ecosystem: a chunk of earth suspended in air with waterfalls pouring off multiple edges, a small forest on top, exposed roots and rocks hanging underneath, and smaller floating rocks nearby connected by ancient chain bridges",
  shipwreck:
    "An underwater shipwreck: a wooden galleon on its side on the ocean floor, holes in the hull, coral and seaweed growing on it, treasure chests spilling gold, and fish swimming around",
  phoenix:
    "A phoenix rising from flames: wings fully spread upward, tail feathers flowing down like fire, head raised to the sky, made of red, orange, and gold blocks with glowstone accents",
  knight: "A knight in armor",
  castle:
    "A medieval stone castle with curtain walls forming a square, four tall corner towers with battlements, a central keep, a gatehouse with an archway and portcullis, and a surrounding moat with a small drawbridge.",
};

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
