import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getPalette } from "@/lib/blocks/palettes";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prompts";
import { getModelByKey, ModelKey } from "@/lib/ai/modelCatalog";
import { makeVoxelBuildJsonSchema } from "@/lib/ai/voxelBuildJsonSchema";
import { anthropicGenerateText } from "@/lib/ai/providers/anthropic";
import { geminiGenerateText } from "@/lib/ai/providers/gemini";
import { openaiGenerateText } from "@/lib/ai/providers/openai";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";

// 75% of grid volume — with primitives (boxes/lines) we can handle much larger builds efficiently
const MAX_BLOCKS_BY_GRID: Record<32 | 64 | 128, number> = {
  32: Math.floor(32 ** 3 * 0.75),   // 24,576
  64: Math.floor(64 ** 3 * 0.75),   // 196,608
  128: Math.floor(128 ** 3 * 0.75), // 1,572,864
};

const MIN_BLOCKS_BY_GRID: Record<32 | 64 | 128, number> = {
  32: 80,
  64: 200,
  128: 300,
};

function defaultMaxOutputTokens(gridSize: 32 | 64 | 128): number {
  // these are optimistic targets; providers may cap lower and we retry down in the provider adapters
  if (gridSize === 32) return 32768;
  if (gridSize === 64) return 65536;
  return 65536;
}

function approxMaxBlocksForTokenBudget(opts: { maxOutputTokens: number; minBlocks: number; hardMax: number }): number {
  // rough heuristic: each block entry costs ~10-20 tokens depending on provider + whitespace
  // use 12 to allow more detail while still reducing truncation risk
  const est = Math.floor(opts.maxOutputTokens / 12);
  return Math.max(opts.minBlocks, Math.min(opts.hardMax, est));
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.2;

export type GenerateVoxelBuildParams = {
  modelKey: ModelKey;
  prompt: string;
  gridSize: 32 | 64 | 128;
  palette: "simple" | "advanced";
  maxAttempts?: number;
  onRetry?: (attempt: number, reason: string) => void;
};

export type GenerateVoxelBuildResult =
  | {
      ok: true;
      build: VoxelBuild;
      warnings: string[];
      blockCount: number;
      generationTimeMs: number;
      rawText: string;
    }
  | { ok: false; error: string; rawText?: string; generationTimeMs: number };

async function providerGenerateText(args: {
  provider: "openai" | "anthropic" | "gemini";
  modelId: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}): Promise<{ text: string }> {
  if (args.provider === "openai") {
    return openaiGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
    });
  }

  if (args.provider === "anthropic") {
    return anthropicGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
    });
  }

  return geminiGenerateText({
    modelId: args.modelId,
    system: args.system,
    user: args.user,
    maxOutputTokens: args.maxOutputTokens,
    temperature: DEFAULT_TEMPERATURE,
    jsonSchema: args.jsonSchema,
  });
}

function validateParsedJson(
  json: unknown,
  palette: BlockDefinition[],
  gridSize: 32 | 64 | 128
) {
  return validateVoxelBuild(json, {
    palette,
    gridSize,
    maxBlocks: MAX_BLOCKS_BY_GRID[gridSize],
  });
}

function buildBounds(build: VoxelBuild) {
  if (build.blocks.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const b of build.blocks) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.z < minZ) minZ = b.z;
    if (b.x > maxX) maxX = b.x;
    if (b.y > maxY) maxY = b.y;
    if (b.z > maxZ) maxZ = b.z;
  }

  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;
  const spanZ = maxZ - minZ + 1;
  return { minX, minY, minZ, maxX, maxY, maxZ, spanX, spanY, spanZ };
}

export async function generateVoxelBuild(params: GenerateVoxelBuildParams): Promise<GenerateVoxelBuildResult> {
  const model = getModelByKey(params.modelKey);
  const paletteDefs = getPalette(params.palette);
  const maxAttempts = params.maxAttempts ?? 3;

  const minBlocks = MIN_BLOCKS_BY_GRID[params.gridSize] ?? 80;
  const maxOutputTokens = defaultMaxOutputTokens(params.gridSize);
  const schemaMaxBlocks = approxMaxBlocksForTokenBudget({
    maxOutputTokens,
    minBlocks,
    hardMax: MAX_BLOCKS_BY_GRID[params.gridSize],
  });
  const jsonSchema = makeVoxelBuildJsonSchema({
    gridSize: params.gridSize,
    minBlocks,
    maxBlocks: schemaMaxBlocks,
  }) as unknown as Record<string, unknown>;
  const system = buildSystemPrompt({
    gridSize: params.gridSize,
    maxBlocks: MAX_BLOCKS_BY_GRID[params.gridSize],
    minBlocks,
    palette: params.palette,
  });

  let previousText = "";
  let lastError = "";
  const start = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const user =
      attempt === 1
        ? buildUserPrompt(params.prompt)
        : buildRepairPrompt({
            error: lastError || "Invalid JSON",
            previousOutput: previousText.slice(0, 20000),
          });

    if (attempt > 1) params.onRetry?.(attempt, lastError);

    try {
      const { text } = await providerGenerateText({
        provider: model.provider,
        modelId: model.modelId,
        system,
        user,
        jsonSchema,
        maxOutputTokens,
      });
      previousText = text;

      const json = extractBestVoxelBuildJson(text);
      if (!json) {
        lastError = "Could not find a valid JSON object in the response";
        continue;
      }

      const validated = validateParsedJson(json, paletteDefs, params.gridSize);
      if (!validated.ok) {
        lastError = validated.error;
        continue;
      }

      if (validated.value.build.blocks.length === 0) {
        lastError =
          "No valid blocks after validation. Use ONLY in-bounds coordinates and ONLY block IDs from the available list.";
        continue;
      }

      if (validated.value.build.blocks.length < minBlocks) {
        lastError = `Build too small (${validated.value.build.blocks.length} blocks). Create at least ~${minBlocks} blocks so the result is recognizable.`;
        continue;
      }

      const bounds = buildBounds(validated.value.build);
      if (bounds) {
        const minFootprint = Math.max(6, Math.floor(params.gridSize * 0.55));
        const minHeight = Math.max(4, Math.floor(params.gridSize * 0.14));
        const maxFootprintSpan = Math.max(bounds.spanX, bounds.spanZ);

        if (maxFootprintSpan < minFootprint) {
          lastError = `Build footprint too small (span ${maxFootprintSpan}). Expand the build to span at least ~${minFootprint} blocks across x or z for more detail.`;
          continue;
        }

        if (bounds.spanY < minHeight) {
          lastError = `Build height too small (span ${bounds.spanY}). Add more vertical structure (span at least ~${minHeight}) so it reads clearly.`;
          continue;
        }
      }

      const generationTimeMs = Date.now() - start;
      return {
        ok: true,
        build: validated.value.build,
        warnings: validated.value.warnings,
        blockCount: validated.value.build.blocks.length,
        generationTimeMs,
        rawText: text,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Provider request failed";
    }
  }

  return {
    ok: false,
    error: lastError || "Generation failed",
    rawText: previousText,
    generationTimeMs: Date.now() - start,
  };
}

export function maxBlocksForGrid(gridSize: 32 | 64 | 128) {
  return MAX_BLOCKS_BY_GRID[gridSize];
}
