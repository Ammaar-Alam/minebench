import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getPalette } from "@/lib/blocks/palettes";
import { extractFirstJsonObject } from "@/lib/ai/jsonExtract";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prompts";
import { getModelByKey, ModelKey } from "@/lib/ai/modelCatalog";
import { anthropicGenerateText } from "@/lib/ai/providers/anthropic";
import { geminiGenerateText } from "@/lib/ai/providers/gemini";
import { openaiGenerateText } from "@/lib/ai/providers/openai";
import { validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";

const MAX_BLOCKS_BY_GRID: Record<32 | 64 | 128, number> = {
  32: 15000,
  64: 40000,
  128: 50000,
};

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
}): Promise<{ text: string }> {
  if (args.provider === "openai") {
    return openaiGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
    });
  }

  if (args.provider === "anthropic") {
    return anthropicGenerateText({
      modelId: args.modelId,
      system: args.system,
      user: args.user,
      maxTokens: 8192,
    });
  }

  return geminiGenerateText({
    modelId: args.modelId,
    system: args.system,
    user: args.user,
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

export async function generateVoxelBuild(params: GenerateVoxelBuildParams): Promise<GenerateVoxelBuildResult> {
  const model = getModelByKey(params.modelKey);
  const paletteDefs = getPalette(params.palette);
  const maxAttempts = params.maxAttempts ?? 3;

  const system = buildSystemPrompt({
    gridSize: params.gridSize,
    maxBlocks: MAX_BLOCKS_BY_GRID[params.gridSize],
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
      });
      previousText = text;

      const json = extractFirstJsonObject(text);
      if (!json) {
        lastError = "Could not find a valid JSON object in the response";
        continue;
      }

      const validated = validateParsedJson(json, paletteDefs, params.gridSize);
      if (!validated.ok) {
        lastError = validated.error;
        continue;
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
