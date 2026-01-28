import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getPalette } from "@/lib/blocks/palettes";
import { extractBestVoxelBuildJson, extractFirstJsonObject } from "@/lib/ai/jsonExtract";
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
import { MAX_BLOCKS_BY_GRID, MIN_BLOCKS_BY_GRID } from "@/lib/ai/limits";
import type { ProviderApiKeys } from "@/lib/ai/types";
import {
  runVoxelExec,
  VOXEL_EXEC_TOOL_NAME,
  voxelExecToolCallJsonSchema,
  voxelExecToolCallSchema,
} from "@/lib/ai/tools/voxelExec";

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

const DEFAULT_TEMPERATURE = 1.0;

function normalizeApiKey(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return v ? v : null;
}

type ProviderKeyName = "openai" | "anthropic" | "gemini" | "moonshot" | "deepseek" | "openrouter";

function envVarForProviderKey(provider: ProviderKeyName): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GOOGLE_AI_API_KEY";
    case "moonshot":
      return "MOONSHOT_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
  }
}

function serverApiKey(provider: ProviderKeyName): string | null {
  const envVar = envVarForProviderKey(provider);
  return normalizeApiKey(process.env[envVar]);
}

function effectiveApiKey(opts: {
  provider: ModelCatalogEntry["provider"] | "openrouter";
  providerKeys?: ProviderApiKeys;
  allowServerKeys: boolean;
}): string | null {
  const provider = opts.provider;
  if (provider === "xai" || provider === "zai" || provider === "meta") return null; // only supported via OpenRouter fallback

  const directKey = normalizeApiKey(
    provider === "openrouter"
      ? opts.providerKeys?.openrouter
      : provider === "openai"
        ? opts.providerKeys?.openai
        : provider === "anthropic"
          ? opts.providerKeys?.anthropic
          : provider === "gemini"
            ? opts.providerKeys?.gemini
            : provider === "moonshot"
              ? opts.providerKeys?.moonshot
              : provider === "deepseek"
                ? opts.providerKeys?.deepseek
                : undefined,
  );
  if (directKey) return directKey;

  if (!opts.allowServerKeys) return null;

  if (provider === "openrouter") return serverApiKey("openrouter");
  if (provider === "openai") return serverApiKey("openai");
  if (provider === "anthropic") return serverApiKey("anthropic");
  if (provider === "gemini") return serverApiKey("gemini");
  if (provider === "moonshot") return serverApiKey("moonshot");
  if (provider === "deepseek") return serverApiKey("deepseek");

  return null;
}

export type GenerateVoxelBuildParams = {
  modelKey: ModelKey;
  prompt: string;
  gridSize: 64 | 256 | 512;
  palette: "simple" | "advanced";
  maxAttempts?: number;
  enableTools?: boolean;
  providerKeys?: ProviderApiKeys;
  allowServerKeys?: boolean;
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
  provider: "openai" | "anthropic" | "gemini" | "moonshot" | "deepseek" | "xai" | "zai" | "meta";
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  if (args.provider === "openai") {
    return openaiGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
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
      apiKey: args.apiKey,
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
      apiKey: args.apiKey,
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
      apiKey: args.apiKey,
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
      apiKey: args.apiKey,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      onDelta: args.onDelta,
    });
  }

  if (args.provider === "xai") {
    throw new Error("xAI direct API not supported; use OpenRouter fallback");
  }

  // Z.AI models are currently OpenRouter-only in MineBench
  if (args.provider === "zai") {
    throw new Error("Z.AI direct API not supported; use OpenRouter fallback");
  }

  // Meta models are currently OpenRouter-only in MineBench
  throw new Error("Meta direct API not supported; use OpenRouter fallback");
}

// unified provider call with OpenRouter fallback
async function providerGenerateText(args: {
  model: ModelCatalogEntry;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  providerKeys?: ProviderApiKeys;
  allowServerKeys: boolean;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const { model } = args;
  const forceOpenRouter = Boolean(model.forceOpenRouter);
  const directKey = forceOpenRouter
    ? null
    : effectiveApiKey({
        provider: model.provider,
        providerKeys: args.providerKeys,
        allowServerKeys: args.allowServerKeys,
      });
  const openRouterKey = effectiveApiKey({
    provider: "openrouter",
    providerKeys: args.providerKeys,
    allowServerKeys: args.allowServerKeys,
  });
  const hasDirect = Boolean(directKey);
  const hasOpenRouter = Boolean(openRouterKey);

  // if we have neither key and there's an openrouter model id, error out
  if (!hasDirect && !hasOpenRouter) {
    if (forceOpenRouter) {
      throw new Error(
        `Missing OpenRouter API key. Provide OPENROUTER_API_KEY to run ${model.displayName}.`,
      );
    }

    const directEnvVar =
      model.provider === "openai"
        ? envVarForProviderKey("openai")
        : model.provider === "anthropic"
          ? envVarForProviderKey("anthropic")
          : model.provider === "gemini"
            ? envVarForProviderKey("gemini")
            : model.provider === "moonshot"
              ? envVarForProviderKey("moonshot")
              : model.provider === "deepseek"
                ? envVarForProviderKey("deepseek")
                : null;

    if (model.openRouterModelId) {
      throw new Error(
        `Missing API key for ${model.provider}. Provide your own ${directEnvVar ?? "provider"} key or an OpenRouter key.`,
      );
    }

    throw new Error(`Missing API key for ${model.provider}. Provide your own ${directEnvVar ?? "provider"} key.`);
  }

  // try direct provider first if we have the key
  if (!forceOpenRouter && hasDirect) {
    try {
      return await callDirectProvider({
        provider: model.provider,
        modelId: model.modelId,
        apiKey: directKey ?? undefined,
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
    apiKey: openRouterKey ?? undefined,
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
  const enableTools = params.enableTools ?? true;
  const maxAttempts = params.maxAttempts ?? (enableTools ? 8 : 3);
  const allowServerKeys = params.allowServerKeys ?? true;

  const minBlocks = MIN_BLOCKS_BY_GRID[params.gridSize] ?? 80;
  const maxOutputTokens = defaultMaxOutputTokens(params.gridSize);
  const schemaMaxBlocks = approxMaxBlocksForTokenBudget({
    maxOutputTokens,
    minBlocks,
    hardMax: MAX_BLOCKS_BY_GRID[params.gridSize],
  });
  const jsonSchema = enableTools
    ? (voxelExecToolCallJsonSchema() as unknown as Record<string, unknown>)
    : (makeVoxelBuildJsonSchema({
        gridSize: params.gridSize,
        minBlocks,
        maxBlocks: schemaMaxBlocks,
      }) as unknown as Record<string, unknown>);
  const baseSystem = buildSystemPrompt({
    gridSize: params.gridSize,
    maxBlocks: MAX_BLOCKS_BY_GRID[params.gridSize],
    minBlocks,
    palette: params.palette,
  });
  const system = enableTools
    ? baseSystem +
      `\n\n## TOOL MODE (${VOXEL_EXEC_TOOL_NAME})\n\n` +
      `You have access to a code-execution tool named "${VOXEL_EXEC_TOOL_NAME}".\n` +
      `- You must do all planning and design yourself.\n` +
      `- The tool only executes your JavaScript to emit voxels; it does not design anything for you.\n\n` +
      `Inside your code you may use ONLY these runtime globals:\n` +
      `- block(x, y, z, type)\n` +
      `- box(x1, y1, z1, x2, y2, z2, type)\n` +
      `- line(x1, y1, z1, x2, y2, z2, type)\n` +
      `- rng() (seeded if you pass seed)\n` +
      `- Math\n\n` +
      `Return ONLY this JSON tool call object (no markdown, no extra keys):\n` +
      `{"tool":"${VOXEL_EXEC_TOOL_NAME}","input":{"code":"...","gridSize":${params.gridSize},"palette":"${params.palette}","seed":123}}\n\n` +
      `NEVER output the voxel build JSON directly; generate it via the tool.\n`
    : baseSystem;

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
          }) +
          (enableTools
            ? `\n\nReminder: return ONLY the ${VOXEL_EXEC_TOOL_NAME} tool call JSON (not the build JSON).`
            : "");

    if (attempt > 1) params.onRetry?.(attempt, lastError);

    try {
      const { text } = await providerGenerateText({
        model,
        system,
        user,
        jsonSchema,
        maxOutputTokens,
        providerKeys: params.providerKeys,
        allowServerKeys,
        onDelta: params.onDelta,
      });
      previousText = text;

      const json = enableTools ? extractFirstJsonObject(text) : extractBestVoxelBuildJson(text);
      if (!json) {
        lastError = "Could not find a valid JSON object in the response";
        continue;
      }

      const buildJson: unknown = enableTools
        ? (() => {
            const parsedCall = voxelExecToolCallSchema.safeParse(json);
            if (!parsedCall.success) {
              lastError = parsedCall.error.message;
              return null;
            }

            const call = parsedCall.data;
            if (call.input.gridSize !== params.gridSize) {
              lastError = `Tool call gridSize mismatch (${call.input.gridSize} vs ${params.gridSize})`;
              return null;
            }
            if (call.input.palette !== params.palette) {
              lastError = `Tool call palette mismatch (${call.input.palette} vs ${params.palette})`;
              return null;
            }

            const run = runVoxelExec({
              code: call.input.code,
              gridSize: params.gridSize,
              palette: params.palette,
              seed: call.input.seed,
            });

            return run.build;
          })()
        : json;

      if (!buildJson) continue;

      const validated = validateParsedJson(buildJson, paletteDefs, params.gridSize);
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

      const spec = parseVoxelBuildSpec(buildJson);
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
