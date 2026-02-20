import { consumeSseStream } from "@/lib/ai/providers/sse";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";

type OpenRouterChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type OpenRouterStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build_response";

function extractTextFromChatCompletions(data: OpenRouterChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type ReasoningConfigAttempt =
  | { kind: "effort"; effort: string }
  | { kind: "max_tokens"; maxTokens: number }
  | "__default__"
  | undefined;

function reasoningConfigFallbacks(opts: {
  efforts?: string[];
  maxTokens?: number;
}): ReasoningConfigAttempt[] {
  const requested = opts.efforts;
  const normalized = (requested ?? [])
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const efforts: ReasoningConfigAttempt[] = [];
  for (const v of normalized) {
    if (!efforts.some((e) => typeof e === "object" && e.kind === "effort" && e.effort === v)) {
      efforts.push({ kind: "effort", effort: v });
    }
  }

  const rawMaxTokens = Number(opts.maxTokens);
  if (Number.isFinite(rawMaxTokens) && rawMaxTokens > 0) {
    efforts.push({ kind: "max_tokens", maxTokens: Math.floor(rawMaxTokens) });
  }

  if (efforts.length === 0) return [undefined];
  // Fallback to plain reasoning mode when effort enums are not supported,
  // then disable reasoning only as a final recovery path.
  return [...efforts, "__default__", undefined];
}

function clampReasoningBudget(maxTokens: number, completionBudget: number): number {
  const cap = Math.max(1, Math.floor(completionBudget) - 1);
  return Math.max(1, Math.min(Math.floor(maxTokens), cap));
}

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    b.includes("max output tokens") ||
    b.includes("maximum") && b.includes("tokens") ||
    b.includes("too many tokens") ||
    b.includes("token limit") ||
    b.includes("context length")
  );
}

function looksLikeReasoningConfigError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    (b.includes("reasoning") &&
      b.includes("effort") &&
      (b.includes("invalid") || b.includes("unsupported") || b.includes("enum") || b.includes("unknown"))) ||
    (b.includes("reasoning") &&
      b.includes("max_tokens") &&
      (b.includes("invalid") || b.includes("unsupported") || b.includes("unknown"))) ||
    (b.includes("reasoning") && b.includes("unsupported")) ||
    (b.includes("reasoning") && b.includes("unknown")) ||
    b.includes("only one of \"reasoning.effort\" and \"reasoning.max_tokens\"")
  );
}

function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { tries: number; minDelayMs: number; maxDelayMs: number },
): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i < opts.tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 || res.status === 429) {
        if (i === opts.tries - 1) return res;
        const delay = Math.min(opts.maxDelayMs, opts.minDelayMs * Math.pow(2, i));
        await sleepMs(delay);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i === opts.tries - 1) throw e;
      const delay = Math.min(opts.maxDelayMs, opts.minDelayMs * Math.pow(2, i));
      await sleepMs(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenRouter request failed");
}

export async function openrouterGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  reasoningMaxTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  reasoningEffortAttempts?: string[];
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api";
  const maxTokens = params.maxOutputTokens ?? 8192;
  const reasoningAttempts = reasoningConfigFallbacks({
    efforts: params.reasoningEffortAttempts,
    maxTokens: params.reasoningMaxTokens,
  });

  const describeReasoningAttempt = (cfg: ReasoningConfigAttempt): string => {
    if (cfg === "__default__") return "default";
    if (cfg == null) return "disabled";
    if (cfg.kind === "effort") return cfg.effort;
    return `max_tokens=${cfg.maxTokens}`;
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_800_000);

  try {
    let res: Response | null = null;
    let lastBody = "";
    let selectedReasoningLabel: string | null = null;
    let selectedReasoningTokenBudget: number | null = null;
    for (const tok of tokenBudgetCandidates(maxTokens)) {
      let tryLowerTokenBudget = false;
      for (const [cfgIdx, cfg] of reasoningAttempts.entries()) {
        const reasoningConfig =
          cfg === "__default__"
            ? {}
            : cfg && typeof cfg === "object" && cfg.kind === "effort"
              ? { effort: cfg.effort }
              : cfg && typeof cfg === "object" && cfg.kind === "max_tokens"
                ? { max_tokens: clampReasoningBudget(cfg.maxTokens, tok) }
              : undefined;

        res = await fetchWithRetry(
          `${baseUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://minebench.dev",
              "X-Title": "MineBench",
              ...(params.onDelta ? { Accept: "text/event-stream" } : {}),
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: params.modelId,
              messages: [
                { role: "system", content: params.system },
                { role: "user", content: params.user },
              ],
              stream: Boolean(params.onDelta),
              temperature: params.temperature ?? 0.2,
              max_tokens: tok,
              reasoning: reasoningConfig,
              ...(params.jsonSchema
                ? {
                    response_format: {
                      type: "json_schema",
                      json_schema: {
                        name: VOXEL_BUILD_JSON_SCHEMA_NAME,
                        strict: true,
                        schema: params.jsonSchema,
                      },
                    },
                  }
                : {}),
            }),
          },
          { tries: 3, minDelayMs: 400, maxDelayMs: 2000 },
        );

        if (res.ok) {
          selectedReasoningLabel = describeReasoningAttempt(cfg);
          selectedReasoningTokenBudget = tok;
          break;
        }
        lastBody = await res.text().catch(() => "");
        if (res.status === 400 && looksLikeTokenLimitError(lastBody)) {
          tryLowerTokenBudget = true;
          break;
        }
        if (res.status === 400 && cfgIdx < reasoningAttempts.length - 1 && looksLikeReasoningConfigError(lastBody)) {
          const currentLabel = describeReasoningAttempt(cfg);
          const nextLabel = describeReasoningAttempt(reasoningAttempts[cfgIdx + 1]);
          params.onTrace?.(
            `OpenRouter reasoning config '${currentLabel}' rejected (HTTP ${res.status}); falling back to '${nextLabel}'.`,
          );
          continue;
        }
        break;
      }

      if (res?.ok) break;
      if (tryLowerTokenBudget) continue;
      break;
    }

    if (!res) throw new Error("OpenRouter request failed");

    if (!res.ok) {
      const body = lastBody || (await res.text().catch(() => ""));
      if (res.status === 400 && params.jsonSchema) {
        const retry = await fetchWithRetry(
          `${baseUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://minebench.dev",
              "X-Title": "MineBench",
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: params.modelId,
              messages: [
                { role: "system", content: params.system },
                { role: "user", content: params.user },
              ],
              stream: false,
              temperature: params.temperature ?? 0.2,
              max_tokens: maxTokens,
            }),
          },
          { tries: 3, minDelayMs: 400, maxDelayMs: 2000 },
        );

        if (!retry.ok) {
          const retryBody = await retry.text().catch(() => "");
          throw new Error(`OpenRouter error ${retry.status}: ${retryBody || body}`);
        }

        const retryData = (await retry.json()) as OpenRouterChatResponse;
        return { text: extractTextFromChatCompletions(retryData) };
      }
      throw new Error(`OpenRouter error ${res.status}: ${body}`);
    }

    if (res.ok && selectedReasoningLabel) {
      const budget = selectedReasoningTokenBudget ?? maxTokens;
      params.onTrace?.(
        withMaxOutputTokens(
          `OpenRouter reasoning config in use: '${selectedReasoningLabel}'.`,
          budget,
        ),
      );
    }

    if (params.onDelta) {
      let text = "";
      await consumeSseStream(res, (evt) => {
        if (evt.data === "[DONE]") return;
        let parsed: OpenRouterStreamChunk | null = null;
        try {
          parsed = JSON.parse(evt.data) as OpenRouterStreamChunk;
        } catch {
          return;
        }
        const chunk = parsed?.choices?.[0]?.delta?.content;
        if (typeof chunk === "string" && chunk) {
          text += chunk;
          params.onDelta?.(chunk);
        }
      });
      return { text };
    }

    const data = (await res.json()) as OpenRouterChatResponse;
    return { text: extractTextFromChatCompletions(data) };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("OpenRouter request timed out");
    }
    console.error("OpenRouter network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    clearTimeout(timeout);
  }
}
