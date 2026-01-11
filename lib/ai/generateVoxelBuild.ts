import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getPalette } from "@/lib/blocks/palettes";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prompts";
import { getModelByKey, ModelKey, ModelCatalogEntry } from "@/lib/ai/modelCatalog";
import { makeVoxelBuildJsonSchema } from "@/lib/ai/voxelBuildJsonSchema";
import { anthropicGenerateText } from "@/lib/ai/providers/anthropic";
import { deepseekGenerateText } from "@/lib/ai/providers/deepseek";
import { geminiGenerateText } from "@/lib/ai/providers/gemini";
import { moonshotGenerateText } from "@/lib/ai/providers/moonshot";
import { openaiGenerateText } from "@/lib/ai/providers/openai";
import { openrouterGenerateText } from "@/lib/ai/providers/openrouter";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";

// 75% of grid volume — with primitives (boxes/lines) we can handle much larger builds efficiently
const MAX_BLOCKS_BY_GRID: Record<64 | 256 | 512, number> = {
  64: Math.floor(64 ** 3 * 0.75), // 196,608
  // Cap higher grids to keep validation/rendering practical.
  256: 2_000_000,
  512: 4_000_000,
};

const MIN_BLOCKS_BY_GRID: Record<64 | 256 | 512, number> = {
  64: 200,
  256: 500,
  512: 800,
};

function defaultMaxOutputTokens(gridSize: 64 | 256 | 512): number {
  // these are optimistic targets; providers may cap lower and we retry down in the provider adapters
  if (gridSize === 64) return 65536;
  return 65536;
}

function approxMaxBlocksForTokenBudget(opts: {
  maxOutputTokens: number;
  minBlocks: number;
  hardMax: number;
}): number {
  // rough heuristic: each block entry costs ~10-20 tokens depending on provider + whitespace
  // use 12 to allow more detail while still reducing truncation risk
  const est = Math.floor(opts.maxOutputTokens / 12);
  return Math.max(opts.minBlocks, Math.min(opts.hardMax, est));
}

const DEFAULT_TEMPERATURE = 0.2;

// check if a direct provider API key is available
function hasDirectProviderKey(provider: string): boolean {
  switch (provider) {
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case "gemini":
      return Boolean(process.env.GOOGLE_AI_API_KEY);
    case "moonshot":
      return Boolean(process.env.MOONSHOT_API_KEY);
    case "deepseek":
      return Boolean(process.env.DEEPSEEK_API_KEY);
    case "xai":
      return Boolean(process.env.XAI_API_KEY);
    default:
      return false;
  }
}

function hasOpenRouterKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export type GenerateVoxelBuildParams = {
  modelKey: ModelKey;
  prompt: string;
  gridSize: 64 | 256 | 512;
  palette: "simple" | "advanced";
  maxAttempts?: number;
  onRetry?: (attempt: number, reason: string) => void;
  onDelta?: (delta: string) => void;
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

// call the direct provider (OpenAI, Anthropic, etc.)
async function callDirectProvider(args: {
  provider: "openai" | "anthropic" | "gemini" | "moonshot" | "deepseek" | "xai";
  modelId: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  if (args.provider === "openai") {
    return openaiGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
      onDelta: args.onDelta,
    });
  }

  if (args.provider === "anthropic") {
    return anthropicGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      maxTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      onDelta: args.onDelta,
    });
  }

  if (args.provider === "gemini") {
    return geminiGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
      onDelta: args.onDelta,
    });
  }

  if (args.provider === "moonshot") {
    return moonshotGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      onDelta: args.onDelta,
    });
  }

  if (args.provider === "deepseek") {
    return deepseekGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      onDelta: args.onDelta,
    });
  }

  // xai doesn't have a direct public API we support yet; throw to trigger OpenRouter fallback
  throw new Error("xAI direct API not supported; use OpenRouter fallback");
}

// unified provider call with OpenRouter fallback
async function providerGenerateText(args: {
  model: ModelCatalogEntry;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const { model } = args;
  const hasDirect = hasDirectProviderKey(model.provider);
  const hasOpenRouter = hasOpenRouterKey();

  // if we have neither key and there's an openrouter model id, error out
  if (!hasDirect && !hasOpenRouter) {
    if (model.openRouterModelId) {
      throw new Error(
        `Missing API key for ${model.provider}. Set ${model.provider.toUpperCase()}_API_KEY or OPENROUTER_API_KEY.`,
      );
    }
    throw new Error(`Missing API key for ${model.provider}. Set ${model.provider.toUpperCase()}_API_KEY.`);
  }

  // try direct provider first if we have the key
  if (hasDirect) {
    try {
      return await callDirectProvider({
        provider: model.provider,
        modelId: model.modelId,
        system: args.system,
        user: args.user,
        jsonSchema: args.jsonSchema,
        maxOutputTokens: args.maxOutputTokens,
        onDelta: args.onDelta,
      });
    } catch (directErr) {
      // If a direct provider key is present, do not fall back to OpenRouter.
      throw directErr;
    }
  }

  // use OpenRouter (either as primary when no direct key, or as fallback)
  if (!model.openRouterModelId) {
    throw new Error(`No OpenRouter model ID configured for ${model.key}`);
  }

  return openrouterGenerateText({
    modelId: model.openRouterModelId,
    system: args.system,
    user: args.user,
    maxOutputTokens: args.maxOutputTokens,
    temperature: DEFAULT_TEMPERATURE,
    onDelta: args.onDelta,
  });
}

function validateParsedJson(json: unknown, palette: BlockDefinition[], gridSize: 64 | 256 | 512) {
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

export async function generateVoxelBuild(
  params: GenerateVoxelBuildParams,
): Promise<GenerateVoxelBuildResult> {
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
            originalPrompt: params.prompt,
          });

    if (attempt > 1) params.onRetry?.(attempt, lastError);

    try {
      const { text } = await providerGenerateText({
        model,
        system,
        user,
        jsonSchema,
        maxOutputTokens,
        onDelta: params.onDelta,
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

      const expandedBuild = validated.value.build;
      const blockCount = expandedBuild.blocks.length;

      if (blockCount === 0) {
        lastError =
          "No valid blocks after validation. Use ONLY in-bounds coordinates and ONLY block IDs from the available list.";
        continue;
      }

      if (blockCount < minBlocks) {
        lastError = `Build too small (${blockCount} blocks). Create at least ~${minBlocks} blocks so the result is recognizable.`;
        continue;
      }

      const bounds = buildBounds(expandedBuild);
      if (bounds) {
        const minFootprint = Math.max(6, Math.floor(params.gridSize * 0.15));
        const minHeight = Math.max(4, Math.floor(params.gridSize * 0.1));
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

      const spec = parseVoxelBuildSpec(json);
      if (!spec.ok) {
        lastError = spec.error;
        continue;
      }

      const generationTimeMs = Date.now() - start;
      return {
        ok: true,
        build: spec.value,
        warnings: validated.value.warnings,
        blockCount,
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

export function maxBlocksForGrid(gridSize: 64 | 256 | 512) {
  return MAX_BLOCKS_BY_GRID[gridSize];
}
