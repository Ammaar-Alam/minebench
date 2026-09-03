import {
  postChatCompletionWithTokenBudgetRetry,
  withMaxOutputTokens,
} from "@/lib/ai/providers/shared";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import type { DeepSeekThinkingConfig } from "@/lib/ai/reasoningProfiles";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";
import type { CustomRequestBody, CustomRequestHeaders } from "@/lib/ai/customProviderConfig";

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

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit")
  );
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
  onAcceptedOutputTokens?: (tokens: number) => void;
  customHeaders?: CustomRequestHeaders;
  customBody?: CustomRequestBody;
} & ProviderTelemetryCallbacks): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

  const baseUrl = normalizeBaseUrl(process.env.DEEPSEEK_BASE_URL);
  const url = `${baseUrl}/v1/chat/completions`;
  const useJsonOutput = Boolean(params.jsonSchema);
  const maxTokens = params.maxOutputTokens ?? 65536;
  const thinkingConfig = params.thinkingConfig ?? { type: "enabled", reasoningEffort: "max" };

  const { res, acceptedTokenBudget: budget } = await postChatCompletionWithTokenBudgetRetry({
    serviceLabel: "DeepSeek",
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

  params.onAcceptedOutputTokens?.(budget);
  params.onAcceptedRequestConfiguration?.({
    apiMode: "chat_completions",
    maxOutputTokens: budget,
    thinkingMode: describeThinkingConfig(thinkingConfig),
    temperature:
      thinkingConfig.type === "disabled" ? (params.temperature ?? 0.2) : "n/a",
    textVerbosity: "default",
    responseFormat: useJsonOutput ? "json_object" : "text",
  });
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
