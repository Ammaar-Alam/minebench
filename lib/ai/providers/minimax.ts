import {
  postChatCompletionWithTokenBudgetRetry,
  withMaxOutputTokens,
} from "@/lib/ai/providers/shared";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";
import type { CustomRequestBody, CustomRequestHeaders } from "@/lib/ai/customProviderConfig";

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

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    b.includes("max tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit") ||
    (b.includes("does not support") && b.includes("tokens >"))
  );
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
  onAcceptedOutputTokens?: (tokens: number) => void;
  customHeaders?: CustomRequestHeaders;
  customBody?: CustomRequestBody;
} & ProviderTelemetryCallbacks): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("Missing MINIMAX_API_KEY");

  const baseUrl = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  // MiniMax requires temperature in (0.0, 1.0]; clamp to avoid rejection
  const rawTemp = params.temperature ?? 0.2;
  const temperature = Math.max(0.01, Math.min(rawTemp, 1.0));
  const maxTokens = params.maxOutputTokens ?? 16384;

  const { res, acceptedTokenBudget: budget } = await postChatCompletionWithTokenBudgetRetry({
    serviceLabel: "MiniMax",
    url,
    apiKey,
    maxOutputTokens: maxTokens,
    stream: Boolean(params.onDelta),
    looksLikeTokenLimitError,
    signal: params.signal,
    onProviderRequest: params.onProviderRequest,
    customHeaders: params.customHeaders,
    customBody: params.customBody,
    buildBody: (tok) => ({
      model: params.modelId,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      stream: Boolean(params.onDelta),
      reasoning_split: true,
      temperature,
      max_completion_tokens: tok,
    }),
  });

  params.onAcceptedOutputTokens?.(budget);
  params.onAcceptedRequestConfiguration?.({
    apiMode: "chat_completions",
    maxOutputTokens: budget,
    thinkingMode: "default",
    temperature,
    textVerbosity: "default",
    responseFormat: "text",
  });
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
