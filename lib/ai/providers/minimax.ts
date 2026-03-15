import { attachAbortSignal } from "@/lib/ai/providers/abort";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";

type MiniMaxChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type MiniMaxChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

function extractTextFromChat(data: MiniMaxChatResponse): string {
  return extractTextContent(data.choices?.[0]?.message?.content);
}

function nextStreamDelta(previousContent: string, nextContent: string): string {
  if (!nextContent) return "";
  if (!previousContent) return nextContent;
  if (nextContent.startsWith(previousContent)) {
    return nextContent.slice(previousContent.length);
  }
  if (previousContent.startsWith(nextContent)) {
    return "";
  }
  return nextContent;
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

export async function minimaxGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("Missing MINIMAX_API_KEY");

  const baseUrl = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  // MiniMax requires temperature in (0.0, 1.0]; clamp to avoid rejection
  const rawTemp = params.temperature ?? 0.2;
  const temperature = Math.max(0.01, Math.min(rawTemp, 1.0));

  const controller = new AbortController();
  const detachAbort = attachAbortSignal(controller, params.signal);
  const timeout: ReturnType<typeof setTimeout> | null = null;

  let res: Response | null = null;
  let lastBody = "";
  const maxTokens = params.maxOutputTokens ?? 16384;
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
          reasoning_split: true,
          temperature,
          max_tokens: tok,
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
      throw new Error("MiniMax request timed out");
    }
    console.error("MiniMax network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`MiniMax request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    detachAbort();
    if (timeout) clearTimeout(timeout);
  }

  if (!res) {
    throw new Error("MiniMax request failed");
  }

  if (!res.ok) {
    const body = lastBody || (await res.text().catch(() => ""));
    const rid = requestIdFromResponse(res);
    throw new Error(`MiniMax error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
  }

  const budget = selectedTokenBudget ?? maxTokens;
  params.onTrace?.(withMaxOutputTokens("MiniMax reasoning config in use: default.", budget));

  if (params.onDelta) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: MiniMaxChatStreamChunk | null = null;
      try {
        parsed = JSON.parse(evt.data) as MiniMaxChatStreamChunk;
      } catch {
        return;
      }
      const cumulativeContent = extractTextContent(parsed?.choices?.[0]?.delta?.content);
      if (!cumulativeContent) return;

      const delta = nextStreamDelta(text, cumulativeContent);
      if (!delta) return;

      if (cumulativeContent.startsWith(text)) {
        text = cumulativeContent;
      } else {
        text += delta;
      }
      params.onDelta?.(delta);
    });
    return { text };
  }

  const data = (await res.json()) as MiniMaxChatResponse;
  const text = extractTextFromChat(data);
  return { text };
}
