import { attachAbortSignal } from "@/lib/ai/providers/abort";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import type { MoonshotThinkingConfig } from "@/lib/ai/reasoningProfiles";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";

type MoonshotChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type MoonshotChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

function extractTextFromChat(data: MoonshotChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
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
    b.includes("max_completion_tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit")
  );
}

function defaultMoonshotTemperature(
  modelId: string,
  thinkingConfig?: MoonshotThinkingConfig,
): number {
  if (modelId === "kimi-k2.6" || modelId === "kimi-k2.5") {
    return thinkingConfig?.type === "disabled" ? 0.6 : 1.0;
  }
  return 0.6;
}

function defaultMoonshotTopP(modelId: string): number | undefined {
  if (modelId.startsWith("kimi-k2")) return 0.95;
  return undefined;
}

function buildStructuredResponseFormat(jsonSchema?: Record<string, unknown>) {
  if (!jsonSchema) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: "minebench_output",
      schema: jsonSchema,
    },
  };
}

function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}

export async function moonshotGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  jsonSchema?: Record<string, unknown>;
  thinkingConfig?: MoonshotThinkingConfig;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.MOONSHOT_API_KEY;
  if (!apiKey) throw new Error("Missing MOONSHOT_API_KEY");

  const baseUrl = (process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/chat/completions`;

  const controller = new AbortController();
  const detachAbort = attachAbortSignal(controller, params.signal);
  const timeout: ReturnType<typeof setTimeout> | null = null;

  let res: Response | null = null;
  let lastBody = "";
  const maxTokens = params.maxOutputTokens ?? 8192;
  let selectedTokenBudget: number | null = null;

  try {
    for (const tok of tokenBudgetCandidates(maxTokens)) {
      const responseFormat = buildStructuredResponseFormat(params.jsonSchema);
      const temperature =
        typeof params.temperature === "number"
          ? params.temperature
          : defaultMoonshotTemperature(params.modelId, params.thinkingConfig);
      const topP = defaultMoonshotTopP(params.modelId);

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
          temperature,
          ...(typeof topP === "number" ? { top_p: topP } : {}),
          max_completion_tokens: tok,
          ...(params.thinkingConfig ? { thinking: params.thinkingConfig } : {}),
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
      });
      if (res.ok) {
        selectedTokenBudget = tok;
        break;
      }
      lastBody = await res.text().catch(() => "");
      if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue;
      break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Moonshot request timed out");
    }
    console.error("Moonshot network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`Moonshot request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    detachAbort();
    if (timeout) clearTimeout(timeout);
  }

  if (!res) {
    throw new Error("Moonshot request failed");
  }

  if (!res.ok) {
    const body = lastBody || (await res.text().catch(() => ""));
    const rid = requestIdFromResponse(res);
    throw new Error(`Moonshot error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
  }

  const budget = selectedTokenBudget ?? maxTokens;
  const thinkingLabel = params.thinkingConfig?.type ?? "default";
  const structuredLabel = params.jsonSchema ? "json_schema" : "text";
  params.onTrace?.(
    withMaxOutputTokens(
      `Moonshot request config in use: thinking=${thinkingLabel}, response_format=${structuredLabel}.`,
      budget,
    ),
  );

  if (params.onDelta) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: MoonshotChatStreamChunk | null = null;
      try {
        parsed = JSON.parse(evt.data) as MoonshotChatStreamChunk;
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

  const data = (await res.json()) as MoonshotChatResponse;
  const text = extractTextFromChat(data);
  return { text };
}
