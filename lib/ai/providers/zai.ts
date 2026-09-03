import {
  extractChatCompletionText,
  postChatCompletionWithTokenBudgetRetry,
  withMaxOutputTokens,
} from "@/lib/ai/providers/shared";
import { modelRecommendedTopP } from "@/lib/ai/modelRequestProfiles";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";
import type { CustomRequestBody, CustomRequestHeaders } from "@/lib/ai/customProviderConfig";

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

function isReasoningEffortRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("z.ai error 400") &&
    message.includes("reasoning") &&
    message.includes("effort") &&
    (message.includes("invalid") ||
      message.includes("unsupported") ||
      message.includes("enum") ||
      message.includes("unknown"))
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
  customHeaders?: CustomRequestHeaders;
  customBody?: CustomRequestBody;
} & ProviderTelemetryCallbacks): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.ZAI_API_KEY;
  if (!apiKey) throw new Error("Missing ZAI_API_KEY");

  const baseUrl = (process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4").replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const maxTokens = params.maxOutputTokens ?? 65_536;
  // GLM always thinks and rejects thinking.type=disabled, so effort alone selects the mode
  const effortAttempts: Array<string | undefined> = params.reasoningEffortAttempts?.length
    ? params.reasoningEffortAttempts
    : [undefined];
  const useJsonOutput = Boolean(params.jsonSchema);
  const stream = Boolean(params.onDelta) || params.modelId === "glm-5.3-flash";
  const topP = modelRecommendedTopP(params.modelId);
  const thinking =
    params.modelId === "glm-5.3-flash"
      ? { type: "enabled", clear_thinking: false }
      : { type: "enabled" };

  let reasoningEffort: string | undefined;
  let response: Awaited<ReturnType<typeof postChatCompletionWithTokenBudgetRetry>> | null = null;
  for (const [index, effort] of effortAttempts.entries()) {
    try {
      response = await postChatCompletionWithTokenBudgetRetry({
        serviceLabel: "Z.AI",
        url,
        apiKey,
        maxOutputTokens: maxTokens,
        stream,
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
          stream,
          max_tokens: tok,
          thinking,
          ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
          ...(topP === undefined ? {} : { top_p: topP }),
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(useJsonOutput ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      reasoningEffort = effort;
      break;
    } catch (error) {
      const nextEffort = effortAttempts[index + 1];
      if (nextEffort === undefined || !isReasoningEffortRejection(error)) throw error;
      params.onTrace?.(
        `Z.AI reasoning config '${effort}' rejected (HTTP 400); falling back to '${nextEffort}'.`,
      );
    }
  }
  if (!response) throw new Error("Z.AI request failed");
  const { res, acceptedTokenBudget: budget } = response;

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

  if (stream) {
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
