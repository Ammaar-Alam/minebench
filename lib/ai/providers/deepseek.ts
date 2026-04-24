import { attachAbortSignal } from "@/lib/ai/providers/abort";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";
import type { DeepSeekThinkingConfig } from "@/lib/ai/reasoningProfiles";

type DeepSeekChatResponse = {
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: { function?: { arguments?: unknown } }[];
    };
  }[];
};

type DeepSeekChatStreamChunk = {
  choices?: {
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: { function?: { arguments?: unknown } }[];
    };
  }[];
};

function extractTextFromChat(data: DeepSeekChatResponse): string {
  const message = data.choices?.[0]?.message;
  const toolArguments = message?.tool_calls?.[0]?.function?.arguments;
  if (typeof toolArguments === "string") return toolArguments;
  if (toolArguments && typeof toolArguments === "object") return JSON.stringify(toolArguments);

  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => String(c ?? "")).join("");
  return "";
}

function requestIdFromResponse(res: Response): string | null {
  return res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? null;
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

function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}

function describeThinkingConfig(config: DeepSeekThinkingConfig): string {
  if (config.type === "disabled") return "disabled";
  return config.reasoningEffort ?? "high";
}

function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  return (trimmed || "https://api.deepseek.com").replace(/\/+$/, "");
}

export async function deepseekGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  thinkingConfig?: DeepSeekThinkingConfig;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

  const baseUrl = normalizeBaseUrl(process.env.DEEPSEEK_BASE_URL);
  const url = `${baseUrl}/v1/chat/completions`;
  const useJsonOutput = Boolean(params.jsonSchema);

  const controller = new AbortController();
  const detachAbort = attachAbortSignal(controller, params.signal);
  const timeout: ReturnType<typeof setTimeout> | null = null;

  let res: Response | null = null;
  let lastBody = "";
  const maxTokens = params.maxOutputTokens ?? 65536;
  const thinkingConfig = params.thinkingConfig ?? { type: "enabled", reasoningEffort: "max" };
  let selectedTokenBudget: number | null = null;
  try {
    for (const tok of tokenBudgetCandidates(maxTokens)) {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
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
          max_tokens: tok,
          thinking: { type: thinkingConfig.type },
          ...(thinkingConfig.type === "enabled" && thinkingConfig.reasoningEffort
            ? { reasoning_effort: thinkingConfig.reasoningEffort }
            : {}),
          ...(useJsonOutput ? { response_format: { type: "json_object" } } : {}),
          ...(thinkingConfig.type === "disabled"
            ? { temperature: params.temperature ?? 0.2 }
            : {}),
        }),
      });
      if (res.ok) {
        selectedTokenBudget = tok;
        break;
      }
      selectedTokenBudget = tok;
      lastBody = await res.text().catch(() => "");
      if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue;
      break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("DeepSeek request timed out");
    }
    console.error("DeepSeek network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`DeepSeek request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    detachAbort();
    if (timeout) clearTimeout(timeout);
  }

  if (!res) {
    throw new Error("DeepSeek request failed");
  }

  if (!res.ok) {
    const body = lastBody || (await res.text().catch(() => ""));
    const rid = requestIdFromResponse(res);
    throw new Error(`DeepSeek error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
  }

  const budget = selectedTokenBudget ?? maxTokens;
  params.onTrace?.(
    withMaxOutputTokens(
      `DeepSeek reasoning mode in use: ${describeThinkingConfig(thinkingConfig)}; structured_output=${useJsonOutput ? "json_object" : "none"}.`,
      budget,
    ),
  );

  if (params.onDelta) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: DeepSeekChatStreamChunk | null = null;
      try {
        parsed = JSON.parse(evt.data) as DeepSeekChatStreamChunk;
      } catch {
        return;
      }
      const delta = parsed?.choices?.[0]?.delta;
      const chunk =
        typeof delta?.content === "string"
          ? delta.content
          : typeof delta?.tool_calls?.[0]?.function?.arguments === "string"
            ? delta.tool_calls[0].function.arguments
            : null;
      if (typeof chunk === "string" && chunk) {
        text += chunk;
        params.onDelta?.(chunk);
      }
    });
    return { text };
  }

  const data = (await res.json()) as DeepSeekChatResponse;
  const text = extractTextFromChat(data);
  return { text };
}
