import type { BlockDefinition } from "@/lib/blocks/palettes";
import { getPalette } from "@/lib/blocks/palettes";
import { extractBestVoxelBuildJson, extractFirstJsonObject } from "@/lib/ai/jsonExtract";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prompts";
import { getModelByKey, ModelKey, ModelCatalogEntry } from "@/lib/ai/modelCatalog";
import { makeVoxelBuildJsonSchema } from "@/lib/ai/voxelBuildJsonSchema";
import { anthropicGenerateText } from "@/lib/ai/providers/anthropic";
import { deepseekGenerateText } from "@/lib/ai/providers/deepseek";
import { geminiGenerateText } from "@/lib/ai/providers/gemini";
import { minimaxGenerateText } from "@/lib/ai/providers/minimax";
import { moonshotGenerateText } from "@/lib/ai/providers/moonshot";
import { openAiCompatibleGenerateText } from "@/lib/ai/providers/nvidia";
import { openaiGenerateText } from "@/lib/ai/providers/openai";
import { openrouterGenerateText } from "@/lib/ai/providers/openrouter";
import { xaiGenerateText } from "@/lib/ai/providers/xai";
import {
  AnthropicAdaptiveEffort,
  anthropicAdaptiveEffortAttempts,
  DeepSeekThinkingConfig,
  deepseekThinkingConfigForModel,
  GeminiThinkingConfig,
  geminiThinkingConfigForModel,
  MoonshotThinkingConfig,
  moonshotThinkingConfigForModel,
  openAiReasoningEffortAttempts,
  openRouterReasoningEnabledForModel,
  openRouterReasoningEffortAttempts as openRouterReasoningEffortAttemptsForModel,
  xaiAutomaticReasoningForModel,
} from "@/lib/ai/reasoningProfiles";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";
import type { VoxelBuild } from "@/lib/voxel/types";
import { MAX_BLOCKS_BY_GRID, MIN_BLOCKS_BY_GRID } from "@/lib/ai/limits";
import type { ProviderApiKeys } from "@/lib/ai/types";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "@/lib/ai/tokenBudgets";
import {
  runVoxelExec,
  VOXEL_EXEC_TOOL_NAME,
  voxelExecToolCallJsonSchema,
  voxelExecToolCallSchema,
} from "@/lib/ai/tools/voxelExec";

const INT_ENV_MAX_OUTPUT_TOKENS = "MINEBENCH_MAX_OUTPUT_TOKENS";

function parseOptionalIntEnvVar(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function defaultOutputTokenRequestForModel(modelId: string): number | undefined {
  if (
    modelId === "deepseek-v4-pro" ||
    modelId === "deepseek-v4-flash" ||
    modelId === "deepseek/deepseek-v4-pro" ||
    modelId === "deepseek/deepseek-v4-flash"
  ) {
    return 384_000;
  }
  return undefined;
}

function maxOutputTokenCapForModel(modelId: string): number | undefined {
  // OpenAI's latest GPT-5 family models use max_output_tokens as a total
  // generation budget that includes reasoning tokens. Most GPT-5 variants in
  // MineBench are currently capped at 128k output tokens, with the older
  // gpt-5-pro alias remaining at 272k.
  if (modelId === "gpt-5-pro") return 272_000;
  if (modelId.startsWith("gpt-5")) return 128_000;
  if (
    modelId === "deepseek-v4-pro" ||
    modelId === "deepseek-v4-flash" ||
    modelId === "deepseek/deepseek-v4-pro" ||
    modelId === "deepseek/deepseek-v4-flash"
  ) {
    return 384_000;
  }
  if (modelId === "deepseek/deepseek-v3.2") return 65_536;
  if (modelId === "glm-5.1" || modelId === "glm-5") return 131_072;
  if (
    modelId.startsWith("claude-opus-4-7") ||
    modelId === "anthropic/claude-opus-4.7"
  ) {
    return 128_000;
  }
  // MiniMax M2.7's OpenAI-compatible route rejects the larger MineBench default
  // output budgets. Keep a lower completion budget so the prompt plus output
  // stays within the model's effective request limit.
  if (modelId === "MiniMax-M2.7") return 131_072;
  if (
    modelId === "grok-4-1-fast" ||
    modelId === "grok-4-1-fast-reasoning" ||
    modelId === "x-ai/grok-4.1-fast"
  ) {
    return 30_000;
  }
  return undefined;
}

function defaultMaxOutputTokens(_gridSize: 64 | 256 | 512, modelId: string): number {
  const requested =
    parseOptionalIntEnvVar(INT_ENV_MAX_OUTPUT_TOKENS) ??
    defaultOutputTokenRequestForModel(modelId) ??
    DEFAULT_MAX_OUTPUT_TOKENS;
  const cap = maxOutputTokenCapForModel(modelId);
  return typeof cap === "number" ? Math.min(requested, cap) : requested;
}

function defaultMaxReasoningTokens(modelId: string, maxOutputTokens: number): number | undefined {
  // For GPT OSS, max_output_tokens is a combined completion/reasoning budget.
  // Use the model's full output budget as the requested reasoning budget.
  if (modelId === "gpt-oss-120b") return maxOutputTokens;
  if (modelId === "claude-sonnet-4-6") return Math.max(1024, maxOutputTokens - 1);
  return undefined;
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

function formatOptionalInteger(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return String(Math.floor(value));
}

function describeRequestedThinkingMode(opts: {
  route: "direct" | "openrouter";
  provider: DirectProvider | "openrouter";
  modelId: string;
  reasoningMaxTokens?: number;
  reasoningEffortAttempts?: string[];
  adaptiveEffortAttempts?: AnthropicAdaptiveEffort[];
  geminiThinkingConfig?: GeminiThinkingConfig;
  moonshotThinkingConfig?: MoonshotThinkingConfig;
  deepseekThinkingConfig?: DeepSeekThinkingConfig;
}): string {
  if (opts.route === "openrouter") {
    if (opts.reasoningEffortAttempts && opts.reasoningEffortAttempts.length > 0) {
      return `effort_fallback=${opts.reasoningEffortAttempts.join("->")}->disabled`;
    }
    if (typeof opts.reasoningMaxTokens === "number") {
      return `reasoning_max_tokens<=${Math.floor(opts.reasoningMaxTokens)}`;
    }
    return "default";
  }

  if (opts.provider === "gemini") {
    if (opts.geminiThinkingConfig?.thinkingLevel) {
      return `thinking_level=${opts.geminiThinkingConfig.thinkingLevel}`;
    }
    if (typeof opts.geminiThinkingConfig?.thinkingBudget === "number") {
      return `thinking_budget=${opts.geminiThinkingConfig.thinkingBudget}`;
    }
    return "default";
  }

  if (opts.provider === "deepseek") {
    if (!opts.deepseekThinkingConfig) return "default";
    if (opts.deepseekThinkingConfig.type === "disabled") return "thinking=disabled";
    return `thinking=${opts.deepseekThinkingConfig.reasoningEffort ?? "high"}`;
  }
  if (opts.provider === "xai") return "automatic";
  if (opts.provider === "moonshot") {
    return opts.moonshotThinkingConfig
      ? `thinking=${opts.moonshotThinkingConfig.type}`
      : "default";
  }
  if (opts.provider === "minimax") return "default";
  if (opts.provider === "custom") return "default";

  if (opts.provider === "openai") {
    if (opts.reasoningEffortAttempts && opts.reasoningEffortAttempts.length > 0) {
      return `reasoning_effort_fallback=${opts.reasoningEffortAttempts.join("->")}->disabled`;
    }
    if (typeof opts.reasoningMaxTokens === "number") {
      return `reasoning_max_tokens<=${Math.floor(opts.reasoningMaxTokens)}`;
    }
    return "default";
  }

  if (opts.provider === "anthropic") {
    if (opts.adaptiveEffortAttempts && opts.adaptiveEffortAttempts.length > 0) {
      return `adaptive_effort=${opts.adaptiveEffortAttempts.join("->")}`;
    }
    if (opts.modelId.startsWith("claude")) return "adaptive_or_default";
    if (typeof opts.reasoningMaxTokens === "number") {
      return `thinking_budget<=${Math.floor(opts.reasoningMaxTokens)}`;
    }
    return "default";
  }

  if (typeof opts.reasoningMaxTokens === "number") {
    return `reasoning_max_tokens<=${Math.floor(opts.reasoningMaxTokens)}`;
  }
  return "default";
}

function providerRequestTraceLine(opts: {
  route: "direct" | "openrouter";
  provider: DirectProvider | "openrouter";
  modelId: string;
  maxOutputTokens: number;
  reasoningMaxTokens?: number;
  reasoningEffortAttempts?: string[];
  openRouterReasoningEnabled?: boolean;
  adaptiveEffortAttempts?: AnthropicAdaptiveEffort[];
  geminiThinkingConfig?: GeminiThinkingConfig;
  moonshotThinkingConfig?: MoonshotThinkingConfig;
  deepseekThinkingConfig?: DeepSeekThinkingConfig;
}): string {
  const thinkingMode =
    opts.route === "openrouter" && opts.openRouterReasoningEnabled
      ? "enabled"
      : describeRequestedThinkingMode(opts);
  const temperature =
    opts.route === "direct" &&
    opts.provider === "deepseek" &&
    opts.deepseekThinkingConfig?.type === "enabled"
      ? "n/a"
      : opts.route === "direct" && opts.provider === "moonshot"
      ? opts.modelId === "kimi-k2.6" || opts.modelId === "kimi-k2.5"
        ? opts.moonshotThinkingConfig?.type === "disabled"
          ? 0.6
          : 1.0
        : 0.6
      : DEFAULT_TEMPERATURE;
  return `Request config: max_output_tokens=${Math.floor(opts.maxOutputTokens)}, reasoning_max_tokens=${formatOptionalInteger(opts.reasoningMaxTokens)}, thinking_mode=${thinkingMode}, temperature=${temperature}.`;
}

type DirectProvider = ModelCatalogEntry["provider"] | "custom";

type ResolvedModel = {
  key: string;
  provider: DirectProvider;
  modelId: string;
  displayName: string;
  openRouterModelId?: string;
  forceOpenRouter?: boolean;
  baseUrl?: string;
};

function isBilledTimeoutStyleProviderError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("und_err_headers_timeout") ||
    m.includes("headerstimeouterror") ||
    m.includes("headers timeout") ||
    m.includes("openai request timed out") ||
    m.includes("anthropic request timed out") ||
    m.includes("request timed out") ||
    (m.includes("openai request failed") && m.includes("timeout")) ||
    (m.includes("anthropic request failed") && m.includes("timeout"))
  );
}

function isExhaustedOutputBudgetProviderError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("status incomplete: max_output_tokens") ||
    m.includes("ended with status incomplete: max_output_tokens")
  );
}

function isDeterministicStructuredSchemaProviderError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("output_config.format.schema") ||
    (m.includes("json_schema") && m.includes("not supported")) ||
    (m.includes("structured output") && m.includes("not supported")) ||
    (m.includes("structured output") && m.includes("invalid"))
  );
}

function normalizeApiKey(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return v ? v : null;
}

type ProviderKeyName =
  | "openai"
  | "anthropic"
  | "gemini"
  | "moonshot"
  | "deepseek"
  | "minimax"
  | "xai"
  | "openrouter"
  | "custom";

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
    case "minimax":
      return "MINIMAX_API_KEY";
    case "xai":
      return "XAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "custom":
      return "CUSTOM_API_KEY";
  }
}

function envVarForDirectProvider(provider: DirectProvider): string | null {
  switch (provider) {
    case "openai":
      return envVarForProviderKey("openai");
    case "anthropic":
      return envVarForProviderKey("anthropic");
    case "gemini":
      return envVarForProviderKey("gemini");
    case "moonshot":
      return envVarForProviderKey("moonshot");
    case "deepseek":
      return envVarForProviderKey("deepseek");
    case "minimax":
      return envVarForProviderKey("minimax");
    case "xai":
      return envVarForProviderKey("xai");
    case "custom":
      return envVarForProviderKey("custom");
    default:
      return null;
  }
}

function serverApiKey(provider: ProviderKeyName): string | null {
  const envVar = envVarForProviderKey(provider);
  return normalizeApiKey(process.env[envVar]);
}

function effectiveApiKey(opts: {
  provider: DirectProvider | "openrouter";
  providerKeys?: ProviderApiKeys;
  allowServerKeys: boolean;
}): string | null {
  const provider = opts.provider;
  if (provider === "zai" || provider === "qwen" || provider === "meta") return null; // only supported via OpenRouter fallback

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
                : provider === "minimax"
                  ? opts.providerKeys?.minimax
                  : provider === "xai"
                    ? opts.providerKeys?.xai
                  : provider === "custom"
                    ? opts.providerKeys?.custom
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
  if (provider === "minimax") return serverApiKey("minimax");
  if (provider === "xai") return serverApiKey("xai");
  if (provider === "custom") return serverApiKey("custom");

  return null;
}

export type GenerateVoxelBuildParams = {
  modelKey?: ModelKey;
  model?: {
    key: string;
    provider: DirectProvider;
    modelId: string;
    displayName: string;
    openRouterModelId?: string;
    forceOpenRouter?: boolean;
    baseUrl?: string;
  };
  prompt: string;
  gridSize: 64 | 256 | 512;
  palette: "simple" | "advanced";
  maxAttempts?: number;
  enableTools?: boolean;
  providerKeys?: ProviderApiKeys;
  allowServerKeys?: boolean;
  preferOpenRouter?: boolean;
  reasoning?: string;
  abortSignal?: AbortSignal;
  onRetry?: (attempt: number, reason: string) => void;
  onDelta?: (delta: string) => void;
  onProviderTrace?: (message: string) => void;
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
  provider:
    | "openai"
    | "anthropic"
    | "gemini"
    | "moonshot"
    | "deepseek"
    | "custom"
    | "xai"
    | "zai"
    | "qwen"
    | "minimax"
    | "meta";
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  reasoningMaxTokens?: number;
  reasoningEffortAttempts?: string[];
  adaptiveEffortAttempts?: AnthropicAdaptiveEffort[];
  geminiThinkingConfig?: GeminiThinkingConfig;
  moonshotThinkingConfig?: MoonshotThinkingConfig;
  deepseekThinkingConfig?: DeepSeekThinkingConfig;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  if (args.provider === "openai") {
    return openaiGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      reasoningMaxTokens: args.reasoningMaxTokens,
      reasoningEffortAttempts: args.reasoningEffortAttempts,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
      signal: args.signal,
      onDelta: args.onDelta,
      onTrace: args.onTrace,
    });
  }

  if (args.provider === "anthropic") {
    return anthropicGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
      system: args.system,
      user: args.user,
      maxTokens: args.maxOutputTokens,
      adaptiveEffortAttempts: args.adaptiveEffortAttempts,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
      signal: args.signal,
      onDelta: args.onDelta,
      onTrace: args.onTrace,
    });
  }

  if (args.provider === "gemini") {
    return geminiGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      thinkingConfig: args.geminiThinkingConfig,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
      signal: args.signal,
      onDelta: args.onDelta,
      onTrace: args.onTrace,
    });
  }

  if (args.provider === "moonshot") {
    return moonshotGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      jsonSchema: args.jsonSchema,
      thinkingConfig: args.moonshotThinkingConfig,
      signal: args.signal,
      onDelta: args.onDelta,
      onTrace: args.onTrace,
    });
  }

  if (args.provider === "deepseek") {
    return deepseekGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      thinkingConfig: args.deepseekThinkingConfig,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
      signal: args.signal,
      onDelta: args.onDelta,
      onTrace: args.onTrace,
    });
  }

  if (args.provider === "custom") {
    return openAiCompatibleGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
      signal: args.signal,
      onDelta: args.onDelta,
      onTrace: args.onTrace,
    });
  }

  if (args.provider === "xai") {
    return xaiGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      jsonSchema: args.jsonSchema,
      signal: args.signal,
      onDelta: args.onDelta,
      onTrace: args.onTrace,
    });
  }

  // Z.AI models are currently OpenRouter-only in MineBench
  if (args.provider === "zai") {
    throw new Error("Z.AI direct API not supported; use OpenRouter fallback");
  }

  // Qwen models are currently OpenRouter-only in MineBench
  if (args.provider === "qwen") {
    throw new Error("Qwen direct API not supported; use OpenRouter fallback");
  }

  if (args.provider === "minimax") {
    return minimaxGenerateText({
      modelId: args.modelId,
      apiKey: args.apiKey,
      system: args.system,
      user: args.user,
      maxOutputTokens: args.maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
      signal: args.signal,
      onDelta: args.onDelta,
      onTrace: args.onTrace,
    });
  }

  // Meta models are currently OpenRouter-only in MineBench
  throw new Error("Meta direct API not supported; use OpenRouter fallback");
}

// unified provider call with OpenRouter fallback
async function providerGenerateText(args: {
  model: ResolvedModel;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  reasoningMaxTokens?: number;
  reasoning?: string;
  providerKeys?: ProviderApiKeys;
  allowServerKeys: boolean;
  preferOpenRouter?: boolean;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onProviderTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const { model } = args;
  const forceOpenRouter = Boolean(model.forceOpenRouter);
  const preferOpenRouter = Boolean(args.preferOpenRouter);
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

  if (preferOpenRouter && !model.openRouterModelId) {
    throw new Error(
      `${model.displayName} is not integrated with OpenRouter in MineBench (missing openRouterModelId).`,
    );
  }
  if (preferOpenRouter && !hasOpenRouter) {
    throw new Error(
      `OpenRouter routing requested for ${model.displayName}, but no OpenRouter API key is available.`,
    );
  }
  if (model.provider === "custom" && preferOpenRouter) {
    throw new Error("OpenRouter routing is unavailable for custom API models.");
  }
  if (model.provider === "custom" && !hasDirect) {
    throw new Error(
      `Missing custom API key. Provide your own ${envVarForProviderKey("custom")} key.`,
    );
  }

  // if we have neither key and there's an openrouter model id, error out
  if (!hasDirect && !hasOpenRouter) {
    if (forceOpenRouter) {
      throw new Error(
        `Missing OpenRouter API key. Provide OPENROUTER_API_KEY to run ${model.displayName}.`,
      );
    }

    const directEnvVar = envVarForDirectProvider(model.provider);

    if (model.openRouterModelId) {
      throw new Error(
        `Missing API key for ${model.provider}. Provide your own ${directEnvVar ?? "provider"} key or an OpenRouter key.`,
      );
    }

    throw new Error(`Missing API key for ${model.provider}. Provide your own ${directEnvVar ?? "provider"} key.`);
  }

  // try direct provider first if we have the key
  if (!forceOpenRouter && !preferOpenRouter && hasDirect) {
    const directOpenAiReasoningEffortAttempts =
      model.provider === "openai"
        ? openAiReasoningEffortAttempts(model.modelId, args.reasoning)
        : undefined;
    const directAnthropicAdaptiveEffortAttempts =
      model.provider === "anthropic"
        ? anthropicAdaptiveEffortAttempts(model.modelId, args.reasoning)
        : undefined;
    const directGeminiThinkingConfig =
      model.provider === "gemini"
        ? geminiThinkingConfigForModel(model.modelId, args.reasoning)
        : undefined;
    const directMoonshotThinkingConfig =
      model.provider === "moonshot"
        ? moonshotThinkingConfigForModel(model.modelId, args.reasoning)
        : undefined;
    const directDeepSeekThinkingConfig =
      model.provider === "deepseek"
        ? deepseekThinkingConfigForModel(model.modelId, args.reasoning)
        : undefined;
    if (model.provider === "xai") {
      xaiAutomaticReasoningForModel(model.modelId, args.reasoning);
    }
    args.onProviderTrace?.(
      `Routing via direct ${model.provider} provider (${model.modelId}). ` +
        providerRequestTraceLine({
          route: "direct",
          provider: model.provider,
          modelId: model.modelId,
          maxOutputTokens: args.maxOutputTokens,
          reasoningMaxTokens: args.reasoningMaxTokens,
          reasoningEffortAttempts: directOpenAiReasoningEffortAttempts,
          adaptiveEffortAttempts: directAnthropicAdaptiveEffortAttempts,
          geminiThinkingConfig: directGeminiThinkingConfig,
          moonshotThinkingConfig: directMoonshotThinkingConfig,
          deepseekThinkingConfig: directDeepSeekThinkingConfig,
        }),
    );
    try {
      return await callDirectProvider({
        provider: model.provider,
        modelId: model.modelId,
        apiKey: directKey ?? undefined,
        baseUrl: model.baseUrl,
        system: args.system,
        user: args.user,
        jsonSchema: args.jsonSchema,
        maxOutputTokens: args.maxOutputTokens,
        reasoningMaxTokens: args.reasoningMaxTokens,
        reasoningEffortAttempts: directOpenAiReasoningEffortAttempts,
        adaptiveEffortAttempts: directAnthropicAdaptiveEffortAttempts,
        geminiThinkingConfig: directGeminiThinkingConfig,
        moonshotThinkingConfig: directMoonshotThinkingConfig,
        deepseekThinkingConfig: directDeepSeekThinkingConfig,
        signal: args.signal,
        onDelta: args.onDelta,
        onTrace: args.onProviderTrace,
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

  const normalizedReasoning = args.reasoning?.trim().toLowerCase();
  const openRouterUsesThinkingToggle =
    model.openRouterModelId === "moonshotai/kimi-k2.6" ||
    model.openRouterModelId === "moonshotai/kimi-k2.5";
  const xaiOpenRouterReasoningEnabled = openRouterReasoningEnabledForModel(
    model.openRouterModelId,
    args.reasoning,
  );
  const openRouterReasoningEnabled =
    xaiOpenRouterReasoningEnabled ??
    (openRouterUsesThinkingToggle
      ? !normalizedReasoning ||
        normalizedReasoning === "enabled" ||
        normalizedReasoning === "default" ||
        normalizedReasoning === "on"
      : false);
  if (
    openRouterUsesThinkingToggle &&
    normalizedReasoning &&
    !["enabled", "default", "on", "disabled", "off", "none"].includes(normalizedReasoning)
  ) {
    throw new Error(
      `OpenRouter model ${model.openRouterModelId} does not support reasoning '${args.reasoning}'. Supported values: enabled, disabled.`,
    );
  }
  const openRouterReasoningEffortAttempts =
    xaiOpenRouterReasoningEnabled !== undefined || openRouterUsesThinkingToggle
      ? undefined
      : openRouterReasoningEffortAttemptsForModel(
          model.openRouterModelId,
          args.reasoning,
        );

  args.onProviderTrace?.(
    `Routing via OpenRouter (${model.openRouterModelId}). ` +
      providerRequestTraceLine({
        route: "openrouter",
        provider: "openrouter",
        modelId: model.openRouterModelId,
        maxOutputTokens: args.maxOutputTokens,
        reasoningMaxTokens: args.reasoningMaxTokens,
        reasoningEffortAttempts: openRouterReasoningEffortAttempts,
        openRouterReasoningEnabled,
      }),
  );

  return openrouterGenerateText({
    modelId: model.openRouterModelId,
    apiKey: openRouterKey ?? undefined,
    system: args.system,
    user: args.user,
    maxOutputTokens: args.maxOutputTokens,
    enableReasoning: openRouterReasoningEnabled,
    reasoningMaxTokens: args.reasoningMaxTokens,
    temperature: DEFAULT_TEMPERATURE,
    jsonSchema: args.jsonSchema,
    reasoningEffortAttempts: openRouterReasoningEffortAttempts,
    signal: args.signal,
    onDelta: args.onDelta,
    onTrace: args.onProviderTrace,
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
  const model: ResolvedModel =
    params.model ??
    (() => {
      if (!params.modelKey) throw new Error("Missing modelKey");
      const catalogModel = getModelByKey(params.modelKey);
      return {
        key: catalogModel.key,
        provider: catalogModel.provider,
        modelId: catalogModel.modelId,
        displayName: catalogModel.displayName,
        openRouterModelId: catalogModel.openRouterModelId,
        forceOpenRouter: catalogModel.forceOpenRouter,
      };
    })();
  const paletteDefs = getPalette(params.palette);
  const enableTools = params.enableTools ?? true;
  const maxAttempts = params.maxAttempts ?? (enableTools ? 8 : 3);
  const allowServerKeys = params.allowServerKeys ?? true;

  const minBlocks = MIN_BLOCKS_BY_GRID[params.gridSize] ?? 80;
  const maxOutputTokens = defaultMaxOutputTokens(params.gridSize, model.modelId);
  const reasoningMaxTokens = defaultMaxReasoningTokens(model.modelId, maxOutputTokens);
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
    enableTools,
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

  params.onProviderTrace?.(
    `Generation config: grid_size=${params.gridSize}, palette=${params.palette}, tool_mode=${enableTools ? VOXEL_EXEC_TOOL_NAME : "disabled"}, min_blocks=${minBlocks}, max_blocks=${MAX_BLOCKS_BY_GRID[params.gridSize]}, schema_max_blocks=${schemaMaxBlocks}, max_output_tokens=${maxOutputTokens}, reasoning_max_tokens=${formatOptionalInteger(reasoningMaxTokens)}.`,
  );

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
        reasoningMaxTokens,
        reasoning: params.reasoning,
        providerKeys: params.providerKeys,
        allowServerKeys,
        preferOpenRouter: params.preferOpenRouter,
        signal: params.abortSignal,
        onDelta: params.onDelta,
        onProviderTrace: params.onProviderTrace,
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
      // Avoid expensive duplicate retries when the upstream likely processed work
      // but the client timed out waiting for headers/body.
      if (isBilledTimeoutStyleProviderError(lastError)) break;
      if (isExhaustedOutputBudgetProviderError(lastError)) break;
      if (isDeterministicStructuredSchemaProviderError(lastError)) break;
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
