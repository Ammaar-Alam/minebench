import {
  extractChatCompletionText,
  postChatCompletionWithTokenBudgetRetry,
  withMaxOutputTokens,
} from "@/lib/ai/providers/shared";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";

type ZaiChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type ZaiChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("token limit")
  );
}

export async function zaiGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  reasoningEffortAttempts?: string[];
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
  onAcceptedOutputTokens?: (tokens: number) => void;
} & ProviderTelemetryCallbacks): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.ZAI_API_KEY;
  if (!apiKey) throw new Error("Missing ZAI_API_KEY");

  const baseUrl = (process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4").replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const maxTokens = params.maxOutputTokens ?? 65_536;
  // GLM always thinks and rejects thinking.type=disabled, so effort alone selects the mode
  const reasoningEffort = params.reasoningEffortAttempts?.[0];
  const useJsonOutput = Boolean(params.jsonSchema);

  const { res, acceptedTokenBudget: budget } = await postChatCompletionWithTokenBudgetRetry({
    serviceLabel: "Z.AI",
    url,
    apiKey,
    maxOutputTokens: maxTokens,
    stream: Boolean(params.onDelta),
    looksLikeTokenLimitError,
    signal: params.signal,
    onProviderRequest: params.onProviderRequest,
    buildBody: (tok) => ({
      model: params.modelId,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      stream: Boolean(params.onDelta),
      max_tokens: tok,
      thinking: { type: "enabled" },
      ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(useJsonOutput ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  const reasoningLabel = reasoningEffort ? `reasoning_effort=${reasoningEffort}` : "default";
  const responseFormat = useJsonOutput ? "json_object" : "text";
  params.onAcceptedOutputTokens?.(budget);
  params.onAcceptedRequestConfiguration?.({
    apiMode: "chat_completions",
    maxOutputTokens: budget,
    thinkingMode: reasoningLabel,
    temperature: params.temperature ?? "default",
    textVerbosity: "default",
    responseFormat,
  });
  params.onTrace?.(
    withMaxOutputTokens(
      `Z.AI request config in use: ${reasoningLabel}, response_format=${responseFormat}.`,
      budget,
    ),
  );

  if (params.onDelta) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: ZaiChatStreamChunk | null = null;
      try {
        parsed = JSON.parse(evt.data) as ZaiChatStreamChunk;
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

  const data = (await res.json()) as ZaiChatResponse;
  const text = extractChatCompletionText(data);
  return { text };
}
