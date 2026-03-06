import { consumeSseStream } from "@/lib/ai/providers/sse";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";

type NvidiaChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type NvidiaChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build_response";

function extractTextFromChat(data: NvidiaChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => String(c ?? "")).join("");
  return "";
}

function requestIdFromResponse(res: Response): string | null {
  return (
    res.headers.get("x-request-id") ??
    res.headers.get("request-id") ??
    res.headers.get("NVCF-REQID") ??
    null
  );
}

function normalizeBaseUrl(raw?: string): string {
  const base = (raw ?? process.env.NVIDIA_BASE_URL ?? "https://inference-api.nvidia.com/v1")
    .trim()
    .replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) {
    return base.slice(0, -"/chat/completions".length);
  }
  return base;
}

function buildChatCompletionsUrl(raw?: string): string {
  const base = normalizeBaseUrl(raw);
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit") ||
    b.includes("context length")
  );
}

function looksLikeStructuredOutputUnsupportedError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    (b.includes("response_format") &&
      (b.includes("unsupported") || b.includes("invalid") || b.includes("unknown"))) ||
    (b.includes("json_schema") &&
      (b.includes("unsupported") || b.includes("invalid") || b.includes("unknown"))) ||
    (b.includes("schema") && b.includes("unsupported"))
  );
}

function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}

export async function openAiCompatibleGenerateText(params: {
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.CUSTOM_API_KEY;
  if (!apiKey) throw new Error("Missing custom API key");

  const url = buildChatCompletionsUrl(params.baseUrl);
  const controller = new AbortController();
  const timeout: ReturnType<typeof setTimeout> | null = null;

  let res: Response | null = null;
  let lastBody = "";
  const maxTokens = params.maxOutputTokens ?? 65_536;
  let selectedTokenBudget: number | null = null;
  let useStructuredOutput = Boolean(params.jsonSchema);

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
          temperature: params.temperature ?? 0.2,
          max_tokens: tok,
          ...(useStructuredOutput && params.jsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: VOXEL_BUILD_JSON_SCHEMA_NAME,
                    strict: true,
                    schema: params.jsonSchema,
                  },
                },
              }
            : {}),
        }),
      });
      if (res.ok) {
        selectedTokenBudget = tok;
        break;
      }
      selectedTokenBudget = tok;
      lastBody = await res.text().catch(() => "");
      if (res.status === 400 && useStructuredOutput && looksLikeStructuredOutputUnsupportedError(lastBody)) {
        useStructuredOutput = false;
        params.onTrace?.("Custom API structured output rejected; falling back to plain text output for this request.");
        continue;
      }
      if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue;
      break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Custom API request timed out");
    }
    console.error("Custom API network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`Custom API request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (!res) {
    throw new Error("Custom API request failed");
  }

  if (!res.ok) {
    const body = lastBody || (await res.text().catch(() => ""));
    const rid = requestIdFromResponse(res);
    throw new Error(`Custom API error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
  }

  const budget = selectedTokenBudget ?? maxTokens;
  params.onTrace?.(
    withMaxOutputTokens(
      useStructuredOutput
        ? "Custom API chat completions in use with structured output."
        : "Custom API chat completions in use without structured output.",
      budget,
    ),
  );

  if (params.onDelta) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: NvidiaChatStreamChunk | null = null;
      try {
        parsed = JSON.parse(evt.data) as NvidiaChatStreamChunk;
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

  const data = (await res.json()) as NvidiaChatResponse;
  const text = extractTextFromChat(data);
  return { text };
}
