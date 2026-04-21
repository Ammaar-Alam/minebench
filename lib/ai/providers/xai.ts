import { openAiCompatibleGenerateText } from "@/lib/ai/providers/nvidia";

export async function xaiGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("Missing XAI_API_KEY");

  const baseUrl = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";

  return openAiCompatibleGenerateText({
    modelId: params.modelId,
    apiKey,
    baseUrl,
    system: params.system,
    user: params.user,
    maxOutputTokens: params.maxOutputTokens,
    temperature: params.temperature,
    jsonSchema: params.jsonSchema,
    serviceLabel: "xAI",
    signal: params.signal,
    onDelta: params.onDelta,
    onTrace: params.onTrace,
  });
}
