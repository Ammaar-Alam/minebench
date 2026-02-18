import { consumeSseStream } from "@/lib/ai/providers/sse";

type AnthropicMessageResponse = {
  content?: {
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
  }[];
};

type AnthropicStreamEvent = {
  type?: unknown;
  delta?: { type?: unknown; text?: unknown } | unknown;
};

type AnthropicEffort = "low" | "medium" | "high" | "max";

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const STRUCTURED_OUTPUT_TOOL_NAME = "emit_structured_json";
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function tokenFallbacks(requested: number): number[] {
  const vals = [requested, 65536, 32768, 16384, 8192]
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  const uniq: number[] = [];
  for (const v of vals) if (!uniq.includes(v)) uniq.push(v);
  return uniq;
}

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit")
  );
}

function looksLikeContextBetaUnavailableError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes(CONTEXT_1M_BETA) ||
    (b.includes("anthropic-beta") &&
      (b.includes("invalid") ||
        b.includes("unknown") ||
        b.includes("unsupported") ||
        b.includes("not available") ||
        b.includes("not enabled") ||
        b.includes("not entitled")))
  );
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return defaultValue;
}

function parseThinkingBudget(): number | null {
  const raw = process.env.ANTHROPIC_THINKING_BUDGET;
  if (!raw) return null;
  const val = Number(raw);
  if (!Number.isFinite(val)) return null;
  const budget = Math.floor(val);
  if (budget < 1024) return null;
  return budget;
}

function parseEffortEnv(
  envVar: string,
  opts: { defaultEffort: AnthropicEffort; allowMax: boolean },
): AnthropicEffort {
  const raw = (process.env[envVar] ?? "").trim().toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  if (raw === "max") return opts.allowMax ? "max" : "high";
  return opts.defaultEffort;
}

function isLegacyManualThinkingModel(modelId: string): boolean {
  return modelId.startsWith("claude-sonnet-4-5") || modelId.startsWith("claude-opus-4-5");
}

function isOpus46(modelId: string): boolean {
  return modelId.startsWith("claude-opus-4-6");
}

function isSonnet46(modelId: string): boolean {
  return modelId.startsWith("claude-sonnet-4-6");
}

function isAdaptiveThinkingModel(modelId: string): boolean {
  return isOpus46(modelId) || isSonnet46(modelId);
}

function parseAdaptiveEffort(modelId: string): AnthropicEffort {
  if (isOpus46(modelId)) {
    return parseEffortEnv("ANTHROPIC_OPUS_4_6_EFFORT", {
      defaultEffort: "max",
      allowMax: true,
    });
  }
  if (isSonnet46(modelId)) {
    return parseEffortEnv("ANTHROPIC_SONNET_4_6_EFFORT", {
      defaultEffort: "high",
      allowMax: false,
    });
  }
  return "high";
}

function supportsContext1mBeta(modelId: string): boolean {
  return (
    modelId.startsWith("claude-opus-4-6") ||
    modelId.startsWith("claude-sonnet-4-5") ||
    modelId.startsWith("claude-sonnet-4")
  );
}

export async function anthropicGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_800_000);

  const maxTokens = Number.isFinite(params.maxTokens) ? Math.floor(params.maxTokens) : 8192;
  const useStructuredOutputs = Boolean(params.jsonSchema);
  const usesAdaptiveThinking = isAdaptiveThinkingModel(params.modelId);
  const streamResponses =
    !useStructuredOutputs &&
    (Boolean(params.onDelta) || parseBooleanEnv("ANTHROPIC_STREAM_RESPONSES", true));
  const thinkingBudget = usesAdaptiveThinking
    ? null
    : isLegacyManualThinkingModel(params.modelId)
      ? Math.max(1024, maxTokens - 1)
      : parseThinkingBudget();
  const outputConfig = usesAdaptiveThinking
    ? { effort: parseAdaptiveEffort(params.modelId) }
    : undefined;
  const betaHeaders: (string | null)[] =
    supportsContext1mBeta(params.modelId) &&
    parseBooleanEnv("ANTHROPIC_ENABLE_1M_CONTEXT_BETA", true)
      ? [CONTEXT_1M_BETA, null]
      : [null];
  const tools = useStructuredOutputs
    ? [
        {
          name: STRUCTURED_OUTPUT_TOOL_NAME,
          description: "Return the final result as JSON that matches the provided schema.",
          input_schema: params.jsonSchema as Record<string, unknown>,
        },
      ]
    : undefined;

  let res: Response | null = null;
  let lastBody = "";
  try {
    requestLoop: for (const tok of tokenFallbacks(maxTokens)) {
      for (const betaHeader of betaHeaders) {
        const budget =
          typeof thinkingBudget === "number" ? Math.min(thinkingBudget, tok - 1) : null;
        const thinking = usesAdaptiveThinking
          ? { type: "adaptive" as const }
          : typeof budget === "number" && budget >= 1024
            ? { type: "enabled" as const, budget_tokens: budget }
            : undefined;
        const temperature = thinking ? 1 : (params.temperature ?? 0.2);

        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            ...(streamResponses ? { Accept: "text/event-stream" } : {}),
            ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: params.modelId,
            max_tokens: tok,
            temperature,
            system: params.system,
            messages: [{ role: "user", content: params.user }],
            stream: streamResponses,
            ...(thinking ? { thinking } : {}),
            ...(outputConfig ? { output_config: outputConfig } : {}),
            ...(tools
              ? {
                  tools,
                  tool_choice: {
                    type: "tool",
                    name: STRUCTURED_OUTPUT_TOOL_NAME,
                    disable_parallel_tool_use: true,
                  },
                }
              : {}),
          }),
        });

        if (res.ok) break requestLoop;
        lastBody = await res.text().catch(() => "");
        if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue requestLoop;
        if (betaHeader && looksLikeContextBetaUnavailableError(lastBody)) continue;
        break requestLoop;
      }

      if (res && !res.ok) break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Anthropic request timed out");
    }
    console.error("Anthropic network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`Anthropic request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res) throw new Error("Anthropic request failed");

  if (!res.ok) {
    const body = lastBody || (await res.text().catch(() => ""));
    throw new Error(`Anthropic error ${res.status}: ${body}`);
  }

  if (streamResponses) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: AnthropicStreamEvent | null = null;
      try {
        parsed = JSON.parse(evt.data) as AnthropicStreamEvent;
      } catch {
        return;
      }
      // message streaming sends incremental deltas on content_block_delta
      if (parsed?.type === "content_block_delta") {
        const deltaObj = parsed.delta as { text?: unknown } | undefined;
        const chunk = deltaObj && typeof deltaObj.text === "string" ? deltaObj.text : "";
        if (chunk) {
          text += chunk;
          params.onDelta?.(chunk);
        }
      }
    });
    return { text };
  }

  const data = (await res.json()) as AnthropicMessageResponse;
  if (useStructuredOutputs) {
    const toolUse = data.content?.find(
      (block) => block.type === "tool_use" && block.name === STRUCTURED_OUTPUT_TOOL_NAME,
    );
    if (toolUse && toolUse.input !== undefined) {
      return { text: JSON.stringify(toolUse.input) };
    }
  }
  const text =
    data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("") ?? "";
  return { text };
}
