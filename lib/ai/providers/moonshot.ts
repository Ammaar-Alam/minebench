import {
  extractChatCompletionText,
  postChatCompletionWithTokenBudgetRetry,
  withMaxOutputTokens,
} from "@/lib/ai/providers/shared";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import type { MoonshotThinkingConfig } from "@/lib/ai/reasoningProfiles";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";
import type { CustomRequestBody, CustomRequestHeaders } from "@/lib/ai/customProviderConfig";

type MoonshotChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type MoonshotChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

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
): number | undefined {
  if (modelId === "kimi-k3") return undefined;
  if (modelId === "kimi-k2.6" || modelId === "kimi-k2.5") {
    return thinkingConfig?.type === "disabled" ? 0.6 : 1.0;
  }
  return 0.6;
}

function defaultMoonshotTopP(modelId: string): number | undefined {
  if (modelId.startsWith("kimi-k2")) return 0.95;
  return undefined;
}

function buildStructuredResponseFormat(modelId: string, jsonSchema?: Record<string, unknown>) {
  if (!jsonSchema) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: "minebench_output",
      ...(modelId === "kimi-k3" ? { strict: true } : {}),
      schema: jsonSchema,
    },
  };
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
  onAcceptedOutputTokens?: (tokens: number) => void;
  customHeaders?: CustomRequestHeaders;
  customBody?: CustomRequestBody;
} & ProviderTelemetryCallbacks): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.MOONSHOT_API_KEY;
  if (!apiKey) throw new Error("Missing MOONSHOT_API_KEY");

  const baseUrl = (process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/chat/completions`;
  const maxTokens = params.maxOutputTokens ?? 8192;
  const responseFormat = buildStructuredResponseFormat(params.modelId, params.jsonSchema);
  const temperature =
    typeof params.temperature === "number"
      ? params.temperature
      : defaultMoonshotTemperature(params.modelId, params.thinkingConfig);
  const topP = defaultMoonshotTopP(params.modelId);

  const { res, acceptedTokenBudget: budget } = await postChatCompletionWithTokenBudgetRetry({
    serviceLabel: "Moonshot",
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
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(typeof topP === "number" ? { top_p: topP } : {}),
      max_completion_tokens: tok,
      ...(params.thinkingConfig?.type
        ? { thinking: { type: params.thinkingConfig.type } }
        : {}),
      ...(params.thinkingConfig?.reasoningEffort
        ? { reasoning_effort: params.thinkingConfig.reasoningEffort }
        : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }),
  });

  params.onAcceptedOutputTokens?.(budget);
  const reasoningLabel = params.thinkingConfig?.reasoningEffort
    ? `reasoning_effort=${params.thinkingConfig.reasoningEffort}`
    : `thinking=${params.thinkingConfig?.type ?? "default"}`;
  const structuredLabel = params.jsonSchema ? "json_schema" : "text";
  params.onAcceptedRequestConfiguration?.({
    apiMode: "chat_completions",
    maxOutputTokens: budget,
    thinkingMode: reasoningLabel,
    temperature:
      typeof params.temperature === "number"
        ? params.temperature
        : (defaultMoonshotTemperature(params.modelId, params.thinkingConfig) ?? "default"),
    textVerbosity: "default",
    responseFormat: structuredLabel,
  });
  params.onTrace?.(
    withMaxOutputTokens(
      `Moonshot request config in use: ${reasoningLabel}, response_format=${structuredLabel}.`,
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
  const text = extractChatCompletionText(data);
  return { text };
}
