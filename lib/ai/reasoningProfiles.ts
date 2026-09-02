import { claudeCapabilities, type ClaudeEffort } from "@/lib/ai/claudeModels";

export type AnthropicAdaptiveEffort = ClaudeEffort;
export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

export type GeminiThinkingConfig = {
  thinkingLevel?: GeminiThinkingLevel;
  thinkingBudget?: number;
};

export type MoonshotThinkingConfig = {
  type?: "enabled" | "disabled";
  reasoningEffort?: "max";
};

export type DeepSeekThinkingConfig = {
  type: "enabled" | "disabled";
  reasoningEffort?: "low" | "high" | "max";
};

function normalizeReasoningOverride(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function isGemini3FlashFamily(modelId: string): boolean {
  return /(?:^|\/)gemini-3(?:[.-]\d+)?-flash/.test(modelId);
}

function gemini3FlashThinkingLevels(modelId: string): readonly GeminiThinkingLevel[] {
  return modelId.endsWith("gemini-3.8-flash") || modelId.endsWith("gemini-3.7-flash")
    ? ["high", "medium", "low"]
    : ["high", "medium", "low", "minimal"];
}

// Explicit override passes through so an unsupported value raises
// Env override degrades to the model's highest level instead, since it is a
// run-wide default that should not fail a model capping lower
function anthropicAdaptiveEffortOverride(modelId: string, override?: string): string | undefined {
  const normalizedOverride = normalizeReasoningOverride(override);
  if (normalizedOverride) return normalizedOverride;

  const { effortLadder, effortEnvVar } = claudeCapabilities(modelId);
  const normalizedEnv = effortEnvVar
    ? normalizeReasoningOverride(process.env[effortEnvVar])
    : undefined;
  if (!normalizedEnv) return undefined;
  if (effortLadder.some((effort) => effort === normalizedEnv)) return normalizedEnv;
  return effortLadder[0];
}

function descendingAttempts<T extends string>(
  label: string,
  allowed: readonly T[],
  override?: string,
  supported?: string,
): T[] {
  const normalized = normalizeReasoningOverride(override);
  if (!normalized) return [...allowed];

  const startIndex = allowed.indexOf(normalized as T);
  if (startIndex < 0) {
    throw new Error(
      `${label} does not support reasoning '${override}'. Supported values: ${supported ?? allowed.join(", ")}.`,
    );
  }

  return [...allowed.slice(startIndex)];
}

// One effort ladder per model or family, shared by the direct route and the
// OpenRouter route so both descend the same values
//
// Resolution is exact `ids` first (either namespace), then the first matching
// `prefixes` rule in array order, so a specific release must sit above its
// broader family. `aliases` map an accepted override onto a ladder entry, or
// onto the ladder head when null (e.g. 'max' meaning "highest available").
type EffortLadderRule = {
  ids?: readonly string[];
  prefixes?: readonly string[];
  ladder: readonly string[];
  aliases?: Readonly<Record<string, string | null>>;
  supported?: string;
};

const EFFORT_LADDER_RULES: readonly EffortLadderRule[] = [
  {
    prefixes: ["gpt-5.6", "openai/gpt-5.6"],
    ladder: ["max", "xhigh", "high", "medium", "low", "none"],
  },
  {
    prefixes: ["gpt-5.5-pro"],
    ids: ["openai/gpt-5.5-pro"],
    ladder: ["xhigh", "high", "medium"],
  },
  {
    prefixes: ["gpt-5.5"],
    ids: ["openai/gpt-5.5"],
    ladder: ["xhigh", "high", "medium", "low", "none"],
  },
  {
    prefixes: ["gpt-5.4-pro"],
    ids: ["openai/gpt-5.4-pro"],
    ladder: ["xhigh", "high", "medium"],
  },
  { ids: ["gpt-5-pro", "openai/gpt-5-pro"], ladder: ["high"] },
  { prefixes: ["gpt-5", "openai/gpt-5"], ladder: ["xhigh", "high"] },
  {
    prefixes: ["gpt-oss"],
    ids: ["openai/gpt-oss-120b"],
    ladder: ["xhigh", "high", "medium", "low"],
  },
  {
    ids: ["muse-spark-1.3", "meta/muse-spark-1.3"],
    ladder: ["xhigh", "high", "medium", "low", "minimal"],
  },
  {
    ids: ["muse-spark-1.2", "meta/muse-spark-1.2"],
    ladder: ["xhigh", "high", "medium", "low", "minimal"],
  },
  {
    ids: ["grok-4.6", "x-ai/grok-4.6"],
    ladder: ["xhigh", "high", "medium", "low"],
    aliases: { max: null },
  },
  {
    ids: ["grok-4.5", "x-ai/grok-4.5"],
    ladder: ["high", "medium", "low"],
    aliases: { max: null, xhigh: null },
  },
  { ids: ["moonshotai/kimi-k3"], ladder: ["max"] },
  {
    ids: ["glm-5.3", "z-ai/glm-5.3", "glm-5.3-flash", "z-ai/glm-5.3-flash"],
    ladder: ["max", "high", "low"],
    aliases: { xhigh: null },
    supported: "max, xhigh, high, low",
  },
  {
    ids: ["z-ai/glm-5.2"],
    ladder: ["xhigh", "high"],
    aliases: { max: null },
    supported: "max, xhigh, high",
  },
  { ids: ["z-ai/glm-5.1", "z-ai/glm-5"], ladder: ["xhigh", "high", "medium", "low"] },
  {
    ids: ["deepseek/deepseek-v4-flash-0731"],
    ladder: ["max", "high", "low"],
    aliases: { xhigh: null },
    supported: "max, xhigh, high, low",
  },
  {
    ids: ["qwen/qwen3-max-thinking", "qwen/qwen3.5-397b-a17b"],
    ladder: ["xhigh", "high", "medium", "low"],
  },
  { ids: ["qwen/qwen3.8-max"], ladder: ["xhigh", "high", "medium", "low", "minimal"] },
  { ids: ["google/gemma-4-31b-it"], ladder: ["high"] },
  {
    ids: ["minimax/minimax-m2.7", "minimax/minimax-m2.5"],
    ladder: ["xhigh", "high", "medium", "low", "minimal"],
  },
];

function effortLadderRuleFor(modelId: string): EffortLadderRule | undefined {
  const exact = EFFORT_LADDER_RULES.find((rule) => rule.ids?.includes(modelId));
  if (exact) return exact;
  return EFFORT_LADDER_RULES.find((rule) =>
    rule.prefixes?.some((prefix) => modelId.startsWith(prefix)),
  );
}

function ladderAttempts(
  label: string,
  rule: EffortLadderRule,
  override?: string,
): string[] {
  const normalized = normalizeReasoningOverride(override);
  const aliased =
    normalized !== undefined && rule.aliases && normalized in rule.aliases
      ? rule.aliases[normalized] ?? undefined
      : normalized;
  return descendingAttempts(label, rule.ladder, aliased, rule.supported);
}

export function openAiReasoningEffortAttempts(
  modelId: string,
  override?: string,
): string[] | undefined {
  const label = `OpenAI model ${modelId}`;
  const rule = effortLadderRuleFor(modelId);
  if (rule) return ladderAttempts(label, rule, override);

  const normalized = normalizeReasoningOverride(override);
  if (normalized) {
    throw new Error(`${label} does not expose a reasoning-effort override.`);
  }
  return undefined;
}

export function metaReasoningEffortAttempts(
  modelId: string,
  override?: string,
): string[] | undefined {
  const label = `Meta model ${modelId}`;
  if (modelId === "muse-spark-1.3" || modelId === "muse-spark-1.2") {
    return ladderAttempts(label, effortLadderRuleFor(modelId)!, override);
  }

  const normalized = normalizeReasoningOverride(override);
  if (normalized) {
    throw new Error(`${label} does not expose a reasoning-effort override.`);
  }
  return undefined;
}

export function zaiReasoningEffortAttempts(
  modelId: string,
  override?: string,
): string[] | undefined {
  const label = `Z.AI model ${modelId}`;
  const rule = effortLadderRuleFor(modelId);
  if (rule) return ladderAttempts(label, rule, override);

  const normalized = normalizeReasoningOverride(override);
  if (normalized) {
    throw new Error(`${label} does not expose a reasoning-effort override.`);
  }
  return undefined;
}

export function modelRequiresReasoning(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return (
    normalized === "grok-4.6" ||
    normalized === "x-ai/grok-4.6" ||
    normalized === "glm-5.3" ||
    normalized === "z-ai/glm-5.3" ||
    normalized === "glm-5.3-flash" ||
    normalized === "z-ai/glm-5.3-flash" ||
    normalized === "google/gemini-3.8-flash" ||
    normalized === "google/gemini-3.7-flash" ||
    normalized === "muse-spark-1.3" ||
    normalized === "meta/muse-spark-1.3" ||
    normalized === "muse-spark-1.2" ||
    normalized === "meta/muse-spark-1.2"
  );
}

// Shared by the direct Anthropic route and the OpenRouter fallback so both
// descend the same effort ladder for a given model
function anthropicAdaptiveAttempts(
  label: string,
  modelId: string,
  override?: string,
): AnthropicAdaptiveEffort[] {
  return descendingAttempts(
    label,
    claudeCapabilities(modelId).effortLadder,
    anthropicAdaptiveEffortOverride(modelId, override),
  );
}

export function anthropicAdaptiveEffortAttempts(
  modelId: string,
  override?: string,
): AnthropicAdaptiveEffort[] | undefined {
  const label = `Anthropic model ${modelId}`;
  if (!claudeCapabilities(modelId).adaptiveThinking) {
    const normalized = normalizeReasoningOverride(override);
    if (normalized) {
      throw new Error(`${label} does not expose an adaptive effort override.`);
    }
    return undefined;
  }

  return anthropicAdaptiveAttempts(label, modelId, override);
}

export function geminiThinkingConfigForModel(
  modelId: string,
  override?: string,
): GeminiThinkingConfig | undefined {
  const normalized = normalizeReasoningOverride(override);

  if (modelId.startsWith("gemini-3")) {
    const allowed: readonly GeminiThinkingLevel[] = isGemini3FlashFamily(modelId)
      ? gemini3FlashThinkingLevels(modelId)
      : ["high", "low"];
    if (!normalized) return { thinkingLevel: "high" };
    if (!allowed.includes(normalized as GeminiThinkingLevel)) {
      throw new Error(
        `Gemini model ${modelId} does not support reasoning '${override}'. Supported values: ${allowed.join(", ")}.`,
      );
    }
    return { thinkingLevel: normalized as GeminiThinkingLevel };
  }

  if (modelId.startsWith("gemma-4")) {
    if (!normalized || normalized === "high") {
      return { thinkingLevel: "high" };
    }
    throw new Error(
      `Gemini model ${modelId} does not support reasoning '${override}'. Supported values: high.`,
    );
  }

  if (modelId.startsWith("gemini-2.5-pro")) {
    if (!normalized || normalized === "dynamic" || normalized === "adaptive") {
      return { thinkingBudget: -1 };
    }
    throw new Error(
      `Gemini model ${modelId} does not support reasoning '${override}'. Supported values: dynamic.`,
    );
  }

  if (normalized) {
    throw new Error(`Gemini model ${modelId} does not expose a thinking override.`);
  }
  return undefined;
}

export function moonshotThinkingConfigForModel(
  modelId: string,
  override?: string,
): MoonshotThinkingConfig | undefined {
  const normalized = normalizeReasoningOverride(override);
  if (modelId === "kimi-k3") {
    if (!normalized || normalized === "default" || normalized === "max") {
      return { reasoningEffort: "max" };
    }
    throw new Error(
      `Moonshot model ${modelId} does not support reasoning '${override}'. Supported values: max.`,
    );
  }

  const supportsThinkingToggle = modelId === "kimi-k2.6" || modelId === "kimi-k2.5";

  if (!supportsThinkingToggle) {
    if (normalized) {
      throw new Error(`Moonshot model ${modelId} does not expose a thinking override.`);
    }
    return undefined;
  }

  if (!normalized || normalized === "enabled" || normalized === "on" || normalized === "default") {
    return { type: "enabled" };
  }

  if (normalized === "disabled" || normalized === "off" || normalized === "none") {
    return { type: "disabled" };
  }

  throw new Error(
    `Moonshot model ${modelId} does not support reasoning '${override}'. Supported values: enabled, disabled.`,
  );
}

export function deepseekThinkingConfigForModel(
  modelId: string,
  override?: string,
): DeepSeekThinkingConfig | undefined {
  const normalized = normalizeReasoningOverride(override);
  const isFlashModel = modelId === "deepseek-v4-flash";
  const supportsThinking =
    modelId === "deepseek-v4-pro" ||
    isFlashModel ||
    modelId === "deepseek-reasoner";

  if (!supportsThinking) {
    if (normalized) {
      throw new Error(`DeepSeek model ${modelId} does not expose a thinking override.`);
    }
    return undefined;
  }

  if (
    !normalized ||
    normalized === "default" ||
    normalized === "enabled" ||
    normalized === "on" ||
    normalized === "true" ||
    normalized === "max" ||
    (normalized === "xhigh" && !isFlashModel)
  ) {
    return { type: "enabled", reasoningEffort: "max" };
  }

  if (normalized === "high") {
    return { type: "enabled", reasoningEffort: "high" };
  }

  if (normalized === "low" && isFlashModel) {
    return { type: "enabled", reasoningEffort: "low" };
  }

  if (normalized === "xhigh" && isFlashModel) {
    return { type: "enabled", reasoningEffort: "high" };
  }

  if (
    normalized === "disabled" ||
    normalized === "off" ||
    normalized === "false" ||
    normalized === "none" ||
    normalized === "non-think" ||
    normalized === "nonthinking"
  ) {
    return { type: "disabled" };
  }

  throw new Error(
    `DeepSeek model ${modelId} does not support reasoning '${override}'. Supported values: max, high${isFlashModel ? ", low" : ""}, disabled.`,
  );
}

export function xaiAutomaticReasoningForModel(
  modelId: string,
  override?: string,
): "automatic" | undefined {
  const normalized = normalizeReasoningOverride(override);
  const label = `xAI model ${modelId}`;
  const isAutomaticReasoningModel =
    modelId === "grok-4.3" ||
    modelId === "x-ai/grok-4.3" ||
    modelId === "grok-4.20-0309-reasoning" ||
    modelId === "grok-4.20-reasoning" ||
    modelId === "grok-4-1-fast-reasoning" ||
    modelId === "grok-4-1-fast";

  if (!isAutomaticReasoningModel) {
    if (normalized) {
      throw new Error(`${label} does not expose a reasoning override.`);
    }
    return undefined;
  }

  if (
    !normalized ||
    normalized === "automatic" ||
    normalized === "auto" ||
    normalized === "enabled" ||
    normalized === "on" ||
    normalized === "true"
  ) {
    return "automatic";
  }

  throw new Error(
    `${label} reasons automatically and does not support reasoning overrides like '${override}'.`,
  );
}

export function xaiReasoningEffortAttempts(
  modelId: string,
  override?: string,
): string[] | undefined {
  const isExplicitEffortModel =
    modelId === "grok-4.6" ||
    modelId === "x-ai/grok-4.6" ||
    modelId === "grok-4.5" ||
    modelId === "x-ai/grok-4.5";
  if (!isExplicitEffortModel) return undefined;

  return ladderAttempts(`xAI model ${modelId}`, effortLadderRuleFor(modelId)!, override);
}

export function openRouterReasoningEffortAttempts(
  modelId: string,
  override?: string,
): string[] | undefined {
  const label = `OpenRouter model ${modelId}`;
  if (modelId === "x-ai/grok-4.6" || modelId === "x-ai/grok-4.5") {
    return xaiReasoningEffortAttempts(modelId, override);
  }
  if (claudeCapabilities(modelId).adaptiveThinking) {
    return anthropicAdaptiveAttempts(label, modelId, override);
  }
  if (modelId.startsWith("google/gemini-3")) {
    return descendingAttempts(
      label,
      isGemini3FlashFamily(modelId)
        ? gemini3FlashThinkingLevels(modelId)
        : ["high", "medium", "low"],
      override,
    );
  }

  const rule = effortLadderRuleFor(modelId);
  if (rule) return ladderAttempts(label, rule, override);

  const normalized = normalizeReasoningOverride(override);
  if (normalized) {
    throw new Error(`${label} does not expose a reasoning-effort override.`);
  }
  return undefined;
}

export function openRouterReasoningEnabledForModel(
  modelId: string,
  override?: string,
): boolean | undefined {
  const normalized = normalizeReasoningOverride(override);
  const label = `OpenRouter model ${modelId}`;
  const isBooleanReasoningModel =
    modelId === "x-ai/grok-4.20" ||
    modelId === "x-ai/grok-4.1-fast";

  if (!isBooleanReasoningModel) {
    return undefined;
  }

  if (!normalized) return true;
  if (
    normalized === "enabled" ||
    normalized === "on" ||
    normalized === "true"
  ) {
    return true;
  }
  if (
    normalized === "disabled" ||
    normalized === "off" ||
    normalized === "false" ||
    normalized === "none"
  ) {
    return false;
  }

  throw new Error(
    `${label} does not support reasoning '${override}'. Supported values: enabled, disabled.`,
  );
}
