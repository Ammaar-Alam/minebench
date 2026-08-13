import { modelUsesDefaultSampling } from "@/lib/ai/modelRequestProfiles";
import { openAiCompatibleGenerateText } from "@/lib/ai/providers/nvidia";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";

export function xaiRequestConfigForModel(
  modelId: string,
  reasoningEffort?: string,
): {
  maxTokensParameter: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: string;
} {
  if (modelId === "grok-4.6" || modelId === "grok-4.5") {
    return {
      maxTokensParameter: "max_completion_tokens",
      reasoningEffort: reasoningEffort ?? (modelId === "grok-4.6" ? "xhigh" : "high"),
    };
  }
  return { maxTokensParameter: "max_tokens" };
}

function isReasoningEffortRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("xai error 400") &&
    message.includes("reasoning") &&
    message.includes("effort") &&
    (message.includes("invalid") ||
      message.includes("unsupported") ||
      message.includes("enum") ||
      message.includes("unknown"))
  );
}

export async function xaiGenerateText(params: {
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
  const apiKey = params.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("Missing XAI_API_KEY");

  const baseUrl = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";
  const requestConfig = xaiRequestConfigForModel(params.modelId);
  const effortAttempts = params.reasoningEffortAttempts?.length
    ? params.reasoningEffortAttempts
    : [requestConfig.reasoningEffort];

  for (const [index, reasoningEffort] of effortAttempts.entries()) {
    try {
      return await openAiCompatibleGenerateText({
        modelId: params.modelId,
        apiKey,
        baseUrl,
        system: params.system,
        user: params.user,
        maxOutputTokens: params.maxOutputTokens,
        maxTokensParameter: requestConfig.maxTokensParameter,
        reasoningEffort,
        temperature: modelUsesDefaultSampling(params.modelId) ? undefined : params.temperature,
        jsonSchema: params.jsonSchema,
        requireStructuredOutput: params.modelId === "grok-4.6",
        serviceLabel: "xAI",
        signal: params.signal,
        onDelta: params.onDelta,
        onTrace: params.onTrace,
        onAcceptedOutputTokens: params.onAcceptedOutputTokens,
        onProviderRequest: params.onProviderRequest,
        onAcceptedRequestConfiguration: params.onAcceptedRequestConfiguration,
      });
    } catch (error) {
      const nextEffort = effortAttempts[index + 1];
      if (nextEffort === undefined || !isReasoningEffortRejection(error)) throw error;
      params.onTrace?.(
        `xAI reasoning config '${reasoningEffort}' rejected (HTTP 400); falling back to '${nextEffort}'.`,
      );
    }
  }

  throw new Error("xAI request failed");
}
