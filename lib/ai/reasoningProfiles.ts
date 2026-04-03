export type AnthropicAdaptiveEffort = "low" | "medium" | "high" | "max";

export type GeminiThinkingConfig = {
  thinkingLevel?: "low" | "high";
  thinkingBudget?: number;
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
    modelId.startsWith("claude-opus-4-6") || modelId.startsWith("claude-sonnet-4-6");
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

export function openRouterReasoningEffortAttempts(
  modelId: string,
  override?: string,
): string[] | undefined {
  const label = `OpenRouter model ${modelId}`;
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
    modelId === "anthropic/claude-sonnet-4.6" ||
    modelId === "anthropic/claude-opus-4.6"
  ) {
    return descendingAttempts(
      label,
      ["max", "xhigh", "high", "medium", "low"],
      override,
    );
  }
  if (modelId === "z-ai/glm-5") {
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
  if (modelId === "minimax/minimax-m2.5") {
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
