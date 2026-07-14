import { openAiCompatibleGenerateText } from "@/lib/ai/providers/nvidia";

export function xaiRequestConfigForModel(
  modelId: string,
  reasoningEffort?: string,
): {
  maxTokensParameter: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: string;
} {
  if (modelId === "grok-4.5") {
    return {
      maxTokensParameter: "max_completion_tokens",
      reasoningEffort: reasoningEffort ?? "high",
    };
  }
  return { maxTokensParameter: "max_tokens" };
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
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("Missing XAI_API_KEY");

  const baseUrl = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";
  const requestConfig = xaiRequestConfigForModel(
    params.modelId,
    params.reasoningEffortAttempts?.[0],
  );

  return openAiCompatibleGenerateText({
    modelId: params.modelId,
    apiKey,
    baseUrl,
    system: params.system,
    user: params.user,
    maxOutputTokens: params.maxOutputTokens,
    maxTokensParameter: requestConfig.maxTokensParameter,
    reasoningEffort: requestConfig.reasoningEffort,
    temperature: params.temperature,
    jsonSchema: params.jsonSchema,
    serviceLabel: "xAI",
    signal: params.signal,
    onDelta: params.onDelta,
    onTrace: params.onTrace,
  });
}
