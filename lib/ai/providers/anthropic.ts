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

function looksLikeStructuredFormatUnsupportedError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("output_config") ||
    b.includes("output format") ||
    b.includes("output_format") ||
    b.includes("json_schema") ||
    b.includes("structured output") ||
    b.includes("unknown field") ||
    b.includes("invalid field")
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

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value)) return defaultValue;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : defaultValue;
}

function requestTimeoutMs(modelId: string): number {
  const globalOverrideMs = parseIntEnv("ANTHROPIC_REQUEST_TIMEOUT_MS", 0);
  if (globalOverrideMs > 0) return globalOverrideMs;
  if (modelId.startsWith("claude-opus-4-6") || modelId.startsWith("claude-sonnet-4-6")) {
    return 7_200_000; // 2 hours for high-effort 4.6 models
  }
  return 1_800_000; // 30 minutes default
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

function effortFallbacks(initial: AnthropicEffort, opts: { allowMax: boolean }): AnthropicEffort[] {
  const ordered: AnthropicEffort[] = opts.allowMax
    ? ["max", "high", "medium", "low"]
    : ["high", "medium", "low"];
  const out: AnthropicEffort[] = [initial];
  for (const effort of ordered) {
    if (!out.includes(effort)) out.push(effort);
  }
  return out;
}

function looksLikeEffortConfigError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    (b.includes("effort") &&
      (b.includes("invalid") ||
        b.includes("unsupported") ||
        b.includes("unknown") ||
        b.includes("enum") ||
        b.includes("must be one of"))) ||
    (b.includes("output_config") &&
      b.includes("effort") &&
      (b.includes("invalid") || b.includes("unsupported") || b.includes("unknown")))
  );
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

function parseAdaptiveEfforts(modelId: string): AnthropicEffort[] {
  if (isOpus46(modelId)) {
    const preferred = parseEffortEnv("ANTHROPIC_OPUS_4_6_EFFORT", {
      defaultEffort: "max",
      allowMax: true,
    });
    return effortFallbacks(preferred, { allowMax: true });
  }
  if (isSonnet46(modelId)) {
    const preferred = parseEffortEnv("ANTHROPIC_SONNET_4_6_EFFORT", {
      defaultEffort: "max",
      allowMax: true,
    });
    return effortFallbacks(preferred, { allowMax: true });
  }
  return ["high"];
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
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs(params.modelId));

  const maxTokens = Number.isFinite(params.maxTokens) ? Math.floor(params.maxTokens) : 8192;
  const useStructuredOutputs = Boolean(params.jsonSchema);
  const usesAdaptiveThinking = isAdaptiveThinkingModel(params.modelId);
  const adaptiveEffortAttempts = usesAdaptiveThinking ? parseAdaptiveEfforts(params.modelId) : [];
  const preferStreaming = Boolean(params.onDelta) || parseBooleanEnv("ANTHROPIC_STREAM_RESPONSES", true);
  const allowForcedToolStructuredFallback = parseBooleanEnv(
    "ANTHROPIC_ALLOW_FORCED_TOOL_STRUCTURED_FALLBACK",
    false,
  );
  const thinkingBudget = usesAdaptiveThinking
    ? null
    : isLegacyManualThinkingModel(params.modelId)
      ? Math.max(1024, maxTokens - 1)
      : parseThinkingBudget();
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
  let structuredMode: "native_format" | "forced_tool" = "native_format";
  let didUseStreaming = false;
  try {
    requestLoop: for (const tok of tokenFallbacks(maxTokens)) {
      betaLoop: for (const betaHeader of betaHeaders) {
        const useForcedToolStructuredOutput =
          useStructuredOutputs && structuredMode === "forced_tool";
        const streamResponses = preferStreaming && !useForcedToolStructuredOutput;
        const budget =
          typeof thinkingBudget === "number" ? Math.min(thinkingBudget, tok - 1) : null;
        const thinking = useForcedToolStructuredOutput
          ? undefined
          : usesAdaptiveThinking
            ? { type: "adaptive" as const }
            : typeof budget === "number" && budget >= 1024
              ? { type: "enabled" as const, budget_tokens: budget }
              : undefined;
        const temperature = thinking ? 1 : (params.temperature ?? 0.2);
        const efforts = usesAdaptiveThinking ? adaptiveEffortAttempts : [null];
        effortLoop: for (let effortIdx = 0; effortIdx < efforts.length; effortIdx += 1) {
          const effort = efforts[effortIdx];
          const outputConfig = useStructuredOutputs
            ? useForcedToolStructuredOutput
              ? undefined
              : {
                  ...(usesAdaptiveThinking && effort ? { effort } : {}),
                  format: {
                    type: "json_schema",
                    schema: params.jsonSchema as Record<string, unknown>,
                  },
                }
            : usesAdaptiveThinking && effort
              ? { effort }
              : undefined;

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
              ...(useForcedToolStructuredOutput && tools
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
          didUseStreaming = streamResponses;

          if (res.ok) break requestLoop;
          lastBody = await res.text().catch(() => "");
          if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue requestLoop;
          if (betaHeader && looksLikeContextBetaUnavailableError(lastBody)) continue betaLoop;
          if (
            usesAdaptiveThinking &&
            res.status === 400 &&
            effortIdx < efforts.length - 1 &&
            looksLikeEffortConfigError(lastBody)
          ) {
            continue effortLoop;
          }
          if (
            useStructuredOutputs &&
            allowForcedToolStructuredFallback &&
            structuredMode === "native_format" &&
            res.status === 400 &&
            looksLikeStructuredFormatUnsupportedError(lastBody)
          ) {
            structuredMode = "forced_tool";
            continue betaLoop;
          }
          break requestLoop;
        }
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

  if (didUseStreaming) {
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
  if (useStructuredOutputs && structuredMode === "forced_tool") {
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
