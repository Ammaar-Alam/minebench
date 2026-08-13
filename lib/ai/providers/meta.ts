import { openAiCompatibleGenerateText } from "@/lib/ai/providers/openaiCompatible";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";

const DEFAULT_META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";

export async function metaGenerateText(params: {
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
  const apiKey = params.apiKey ?? process.env.META_MODEL_API_KEY;
  if (!apiKey) throw new Error("Missing META_MODEL_API_KEY");

  return openAiCompatibleGenerateText({
    modelId: params.modelId,
    apiKey,
    baseUrl: process.env.META_MODEL_API_BASE_URL ?? DEFAULT_META_MODEL_API_BASE_URL,
    system: params.system,
    user: params.user,
    maxOutputTokens: params.maxOutputTokens,
    maxTokensParameter: "max_completion_tokens",
    reasoningEffort: params.reasoningEffortAttempts?.[0] ?? "xhigh",
    temperature: params.temperature,
    jsonSchema: params.jsonSchema,
    serviceLabel: "Meta Model API",
    requireStructuredOutput: true,
    signal: params.signal,
    onDelta: params.onDelta,
    onTrace: params.onTrace,
    onAcceptedOutputTokens: params.onAcceptedOutputTokens,
    onProviderRequest: params.onProviderRequest,
    onAcceptedRequestConfiguration: params.onAcceptedRequestConfiguration,
  });
}
