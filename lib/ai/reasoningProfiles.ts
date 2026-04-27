export type AnthropicAdaptiveEffort = "low" | "medium" | "high" | "max";

export type GeminiThinkingConfig = {
  thinkingLevel?: "low" | "high";
  thinkingBudget?: number;
};

export type MoonshotThinkingConfig = {
  type: "enabled" | "disabled";
};

export type DeepSeekThinkingConfig = {
  type: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
};

function normalizeReasoningOverride(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function descendingAttempts<T extends string>(
  label: string,
  allowed: readonly T[],
  override?: string,
): T[] {
  const normalized = normalizeReasoningOverride(override);
  if (!normalized) return [...allowed];

  const startIndex = allowed.indexOf(normalized as T);
  if (startIndex < 0) {
    throw new Error(
      `${label} does not support reasoning '${override}'. Supported values: ${allowed.join(", ")}.`,
    );
  }

  return [...allowed.slice(startIndex)];
}

export function openAiReasoningEffortAttempts(
  modelId: string,
  override?: string,
): string[] | undefined {
  const label = `OpenAI model ${modelId}`;
  if (modelId.startsWith("gpt-5.5-pro")) {
    return descendingAttempts(label, ["xhigh", "high", "medium"], override);
  }
  if (modelId.startsWith("gpt-5.5")) {
    return descendingAttempts(label, ["xhigh", "high", "medium", "low", "none"], override);
  }
  if (modelId.startsWith("gpt-5.4-pro")) {
    return descendingAttempts(label, ["xhigh", "high", "medium"], override);
  }
  if (modelId === "gpt-5-pro") {
    return descendingAttempts(label, ["high"], override);
  }
  if (modelId.startsWith("gpt-5")) {
    return descendingAttempts(label, ["xhigh", "high"], override);
  }
  if (modelId.startsWith("gpt-oss")) {
    return descendingAttempts(label, ["xhigh", "high", "medium", "low"], override);
  }

  const normalized = normalizeReasoningOverride(override);
  if (normalized) {
    throw new Error(`${label} does not expose a reasoning-effort override.`);
  }
  return undefined;
}

export function anthropicAdaptiveEffortAttempts(
  modelId: string,
  override?: string,
): AnthropicAdaptiveEffort[] | undefined {
  const isAdaptiveModel =
    modelId.startsWith("claude-opus-4-7") ||
    modelId.startsWith("claude-opus-4-6") ||
    modelId.startsWith("claude-sonnet-4-6");
  if (!isAdaptiveModel) {
    const normalized = normalizeReasoningOverride(override);
    if (normalized) {
      throw new Error(`Anthropic model ${modelId} does not expose an adaptive effort override.`);
    }
    return undefined;
  }

  return descendingAttempts(
    `Anthropic model ${modelId}`,
    ["max", "high", "medium", "low"],
    override,
  );
}

export function geminiThinkingConfigForModel(
  modelId: string,
  override?: string,
): GeminiThinkingConfig | undefined {
  const normalized = normalizeReasoningOverride(override);

  if (modelId.startsWith("gemini-3")) {
    if (!normalized) return { thinkingLevel: "high" };
    if (normalized !== "high" && normalized !== "low") {
      throw new Error(
        `Gemini model ${modelId} does not support reasoning '${override}'. Supported values: high, low.`,
      );
    }
    return { thinkingLevel: normalized };
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
  const supportsThinking =
    modelId === "deepseek-v4-pro" ||
    modelId === "deepseek-v4-flash" ||
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
    normalized === "xhigh"
  ) {
    return { type: "enabled", reasoningEffort: "max" };
  }

  if (normalized === "high") {
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
    `DeepSeek model ${modelId} does not support reasoning '${override}'. Supported values: max, high, disabled.`,
  );
}

export function xaiAutomaticReasoningForModel(
  modelId: string,
  override?: string,
): "automatic" | undefined {
  const normalized = normalizeReasoningOverride(override);
  const label = `xAI model ${modelId}`;
  const isAutomaticReasoningModel =
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

export function openRouterReasoningEffortAttempts(
  modelId: string,
  override?: string,
): string[] | undefined {
  const label = `OpenRouter model ${modelId}`;
  if (modelId === "openai/gpt-5.5-pro") {
    return descendingAttempts(label, ["xhigh", "high", "medium"], override);
  }
  if (modelId === "openai/gpt-5.5") {
    return descendingAttempts(label, ["xhigh", "high", "medium", "low", "none"], override);
  }
  if (modelId === "openai/gpt-5.4-pro") {
    return descendingAttempts(label, ["xhigh", "high", "medium"], override);
  }
  if (modelId === "openai/gpt-5-pro") {
    return descendingAttempts(label, ["high"], override);
  }
  if (modelId.startsWith("openai/gpt-5")) {
    return descendingAttempts(label, ["xhigh", "high"], override);
  }
  if (
    modelId === "anthropic/claude-opus-4.7" ||
    modelId === "anthropic/claude-sonnet-4.6" ||
    modelId === "anthropic/claude-opus-4.6"
  ) {
    return descendingAttempts(
      label,
      ["max", "xhigh", "high", "medium", "low"],
      override,
    );
  }
  if (
    modelId === "z-ai/glm-5.1" ||
    modelId === "z-ai/glm-5"
  ) {
    return descendingAttempts(label, ["xhigh", "high", "medium", "low"], override);
  }
  if (modelId.startsWith("google/gemini-3")) {
    return descendingAttempts(label, ["high", "medium", "low", "minimal"], override);
  }
  if (modelId === "google/gemma-4-31b-it") {
    return descendingAttempts(label, ["high"], override);
  }
  if (
    modelId === "qwen/qwen3-max-thinking" ||
    modelId === "qwen/qwen3.5-397b-a17b"
  ) {
    return descendingAttempts(label, ["xhigh", "high", "medium", "low"], override);
  }
  if (modelId === "openai/gpt-oss-120b") {
    return descendingAttempts(label, ["xhigh", "high", "medium", "low"], override);
  }
  if (
    modelId === "minimax/minimax-m2.7" ||
    modelId === "minimax/minimax-m2.5"
  ) {
    return descendingAttempts(
      label,
      ["xhigh", "high", "medium", "low", "minimal"],
      override,
    );
  }

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
