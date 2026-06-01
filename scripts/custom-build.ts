import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "fflate";
import { getModelByKey, type ModelKey } from "@/lib/ai/modelCatalog";
import { generateVoxelBuild } from "@/lib/ai/generateVoxelBuild";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { MAX_BLOCKS_BY_GRID, type GridSize } from "@/lib/ai/limits";
import { generateCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { sha256Hex } from "@/lib/custom-builds/artifacts";
import { getPalette } from "@/lib/blocks/palettes";
import { exportVoxelBuild, type VoxelBuildExportFormat } from "@/lib/voxel/export";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";

type Palette = "simple" | "advanced";

type Args = {
  prompt?: string;
  promptFile?: string;
  jsonFile?: string;
  modelKey: ModelKey;
  gridSize: GridSize;
  palette: Palette;
  outDir?: string;
  exports: VoxelBuildExportFormat[];
  preferOpenRouter: boolean;
  enableTools: boolean;
  maxAttempts?: number;
  reasoning?: string;
};

const EXPORT_FORMATS: VoxelBuildExportFormat[] = ["glb", "stl", "schem"];

function usage(): string {
  return `MineBench custom build CLI

Usage:
  pnpm custom:build --prompt "a stone bridge" --model openai_gpt_5_4_mini
  pnpm custom:build --prompt-file prompt.txt --model anthropic_claude_4_8_opus --prefer-openrouter
  pnpm custom:build --json build.json --exports glb,schem --out exports/stone-bridge

Options:
  --prompt TEXT             Prompt to generate.
  --prompt-file PATH        Read the prompt from a text file.
  --json PATH               Export an existing MineBench build JSON instead of generating.
  --model MODEL_KEY         Catalog model key. Default: openai_gpt_5_4_mini.
  --grid-size 64|256|512    Build grid. Default: 256.
  --palette simple|advanced Block palette. Default: simple.
  --out DIR                 Output directory. Default: custom-builds/date-and-prompt-slug.
  --exports LIST            glb, stl, schem, all, or none. Default: all.
  --prefer-openrouter       Prefer OPENROUTER_API_KEY when the model has an OpenRouter ID.
  --no-tools                Disable voxel.exec tool mode.
  --max-attempts NUMBER     Override generation retry count.
  --reasoning PROFILE       Optional reasoning profile passed to the provider.
  --help                    Show this help.`;
}

function parseGridSize(value: string): GridSize {
  const parsed = Number.parseInt(value, 10);
  if (parsed === 64 || parsed === 256 || parsed === 512) return parsed;
  throw new Error("--grid-size must be 64, 256, or 512");
}

function parsePalette(value: string): Palette {
  if (value === "simple" || value === "advanced") return value;
  throw new Error("--palette must be simple or advanced");
}

function parseExports(value: string): VoxelBuildExportFormat[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none") return [];
  if (normalized === "all") return [...EXPORT_FORMATS];
  const requested = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const unique = new Set<VoxelBuildExportFormat>();
  for (const format of requested) {
    if (!EXPORT_FORMATS.includes(format as VoxelBuildExportFormat)) {
      throw new Error("--exports supports glb, stl, schem, all, or none");
    }
    unique.add(format as VoxelBuildExportFormat);
  }
  return Array.from(unique);
}

function parseModelKey(value: string): ModelKey {
  getModelByKey(value as ModelKey);
  return value as ModelKey;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    modelKey: "openai_gpt_5_4_mini",
    gridSize: 256,
    palette: "simple",
    exports: [...EXPORT_FORMATS],
    preferOpenRouter: false,
    enableTools: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (flag === "--prompt") {
      args.prompt = takeValue(argv, i, flag);
      i += 1;
      continue;
    }
    if (flag === "--prompt-file") {
      args.promptFile = takeValue(argv, i, flag);
      i += 1;
      continue;
    }
    if (flag === "--json") {
      args.jsonFile = takeValue(argv, i, flag);
      i += 1;
      continue;
    }
    if (flag === "--model") {
      args.modelKey = parseModelKey(takeValue(argv, i, flag));
      i += 1;
      continue;
    }
    if (flag === "--grid-size") {
      args.gridSize = parseGridSize(takeValue(argv, i, flag));
      i += 1;
      continue;
    }
    if (flag === "--palette") {
      args.palette = parsePalette(takeValue(argv, i, flag));
      i += 1;
      continue;
    }
    if (flag === "--out") {
      args.outDir = takeValue(argv, i, flag);
      i += 1;
      continue;
    }
    if (flag === "--exports") {
      args.exports = parseExports(takeValue(argv, i, flag));
      i += 1;
      continue;
    }
    if (flag === "--prefer-openrouter") {
      args.preferOpenRouter = true;
      continue;
    }
    if (flag === "--no-tools") {
      args.enableTools = false;
      continue;
    }
    if (flag === "--max-attempts") {
      args.maxAttempts = parsePositiveInt(takeValue(argv, i, flag), flag);
      i += 1;
      continue;
    }
    if (flag === "--reasoning") {
      args.reasoning = takeValue(argv, i, flag);
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }

  if (!args.jsonFile && !args.prompt && !args.promptFile) {
    throw new Error("Provide --prompt, --prompt-file, or --json");
  }
  if (args.prompt && args.promptFile) {
    throw new Error("Use either --prompt or --prompt-file, not both");
  }
  return args;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "custom-build";
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readPrompt(args: Args): Promise<string | null> {
  if (args.promptFile) {
    const text = await readFile(args.promptFile, "utf8");
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`Prompt file is empty: ${args.promptFile}`);
    return trimmed;
  }
  if (args.prompt) {
    const trimmed = args.prompt.trim();
    if (!trimmed) throw new Error("--prompt cannot be empty");
    return trimmed;
  }
  return null;
}

function parseBuildText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const extracted = extractBestVoxelBuildJson(text);
    if (!extracted) throw new Error("Input file does not contain MineBench build JSON");
    return extracted;
  }
}

async function loadBuildFromJson(args: Args): Promise<{ build: VoxelBuild; warnings: string[] }> {
  if (!args.jsonFile) throw new Error("Missing --json path");
  const text = await readFile(args.jsonFile, "utf8");
  const parsed = parseVoxelBuildSpec(parseBuildText(text));
  if (!parsed.ok) throw new Error(`Invalid MineBench build JSON: ${parsed.error}`);
  return validateBuildForOutput(args, parsed.value, "MineBench build JSON");
}

function validateBuildForOutput(
  args: Pick<Args, "gridSize" | "palette">,
  build: VoxelBuild,
  source: string,
): { build: VoxelBuild; warnings: string[] } {
  const validated = validateVoxelBuild(build, {
    gridSize: args.gridSize,
    palette: getPalette(args.palette),
    maxBlocks: MAX_BLOCKS_BY_GRID[args.gridSize],
  });
  if (!validated.ok) throw new Error(`Invalid ${source}: ${validated.error}`);
  return validated.value;
}

async function generateBuild(args: Args, prompt: string): Promise<{
  build: VoxelBuild;
  warnings: string[];
  generationTimeMs: number;
  rawText: string;
}> {
  const result = await generateVoxelBuild({
    modelKey: args.modelKey,
    prompt,
    gridSize: args.gridSize,
    palette: args.palette,
    enableTools: args.enableTools,
    maxAttempts: args.maxAttempts,
    preferOpenRouter: args.preferOpenRouter,
    reasoning: args.reasoning,
    allowServerKeys: true,
    onRetry: (attempt, reason) => {
      console.warn(`retry ${attempt}: ${reason}`);
    },
    onProviderTrace: (message) => {
      console.warn(message);
    },
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  const validated = validateBuildForOutput(args, result.build, "generated MineBench build");
  return {
    build: validated.build,
    warnings: Array.from(new Set([...result.warnings, ...validated.warnings])),
    generationTimeMs: result.generationTimeMs,
    rawText: result.rawText,
  };
}

function defaultOutputDir(args: Args, prompt: string | null): string {
  const seed = prompt ?? args.jsonFile ?? "custom-build";
  return path.join("custom-builds", `${timestampSlug()}-${slugify(seed)}`);
}

async function writeArtifact(filePath: string, bytes: Uint8Array): Promise<number> {
  await writeFile(filePath, bytes);
  return bytes.byteLength;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = await readPrompt(args);
  const publicId = generateCustomBuildPublicId();
  const outDir = path.resolve(args.outDir ?? defaultOutputDir(args, prompt));
  await mkdir(outDir, { recursive: true });

  const generated = args.jsonFile
    ? {
        ...(await loadBuildFromJson(args)),
        generationTimeMs: null,
        rawText: null,
      }
    : {
        ...(await generateBuild(args, prompt ?? "")),
      };

  const buildJson = JSON.stringify(generated.build);
  const buildPrettyJson = JSON.stringify(generated.build, null, 2);
  const buildBytes = new TextEncoder().encode(buildJson);
  const prettyBytes = new TextEncoder().encode(buildPrettyJson);
  const gzipBytes = gzipSync(buildBytes, { mtime: 0 });
  const buildSha256 = sha256Hex(buildBytes);

  const files: Record<string, { path: string; bytes: number }> = {};
  files.json = {
    path: path.join(outDir, "build.json"),
    bytes: await writeArtifact(path.join(outDir, "build.json"), prettyBytes),
  };
  files.jsonGzip = {
    path: path.join(outDir, "build.json.gz"),
    bytes: await writeArtifact(path.join(outDir, "build.json.gz"), gzipBytes),
  };

  if (generated.rawText) {
    const rawBytes = new TextEncoder().encode(generated.rawText);
    files.rawText = {
      path: path.join(outDir, "raw-output.txt"),
      bytes: await writeArtifact(path.join(outDir, "raw-output.txt"), rawBytes),
    };
  }

  const palette = getPalette(args.palette);
  for (const format of args.exports) {
    const artifact = exportVoxelBuild(generated.build, palette, format);
    const bytes = format === "schem" ? gzipSync(artifact.bytes, { mtime: 0 }) : artifact.bytes;
    const filePath = path.join(outDir, `build.${artifact.extension}`);
    files[format] = {
      path: filePath,
      bytes: await writeArtifact(filePath, bytes),
    };
  }

  const model = getModelByKey(args.modelKey);
  const metadata = {
    id: publicId,
    createdAt: new Date().toISOString(),
    prompt,
    sourceJson: args.jsonFile ? path.resolve(args.jsonFile) : null,
    model: args.jsonFile
      ? null
      : {
          key: model.key,
          provider: model.provider,
          modelId: model.modelId,
          displayName: model.displayName,
          preferOpenRouter: args.preferOpenRouter,
        },
    gridSize: args.gridSize,
    palette: args.palette,
    blockCount: generated.build.blocks.length,
    warnings: generated.warnings,
    generationTimeMs: generated.generationTimeMs,
    buildSha256,
    files,
  };
  await writeFile(path.join(outDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  console.log(`Wrote custom build to ${outDir}`);
  console.log(`Blocks: ${generated.build.blocks.length.toLocaleString()}`);
  console.log(`SHA-256: ${buildSha256}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
