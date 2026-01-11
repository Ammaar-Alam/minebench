import { consumeSseStream } from "@/lib/ai/providers/sse";

type DeepSeekChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type DeepSeekChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

function extractTextFromChat(data: DeepSeekChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => String(c ?? "")).join("");
  return "";
}

function requestIdFromResponse(res: Response): string | null {
  return res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? null;
}

export async function deepseekGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_800_000);

  let res: Response;
  try {
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
        max_tokens: params.maxOutputTokens ?? 65536,
        thinking: { type: "enabled" },
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("DeepSeek request timed out");
    }
    console.error("DeepSeek network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`DeepSeek request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const rid = requestIdFromResponse(res);
    throw new Error(`DeepSeek error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
  }

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
      const chunk = parsed?.choices?.[0]?.delta?.content;
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
