import { consumeSseStream } from "@/lib/ai/providers/sse";

type MoonshotChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type MoonshotChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

function extractTextFromChat(data: MoonshotChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => String(c ?? "")).join("");
  return "";
}

function requestIdFromResponse(res: Response): string | null {
  return res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? null;
}

export async function moonshotGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) throw new Error("Missing MOONSHOT_API_KEY");

  const baseUrl = (process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.cn").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

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
        max_tokens: params.maxOutputTokens ?? 8192,
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Moonshot request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const rid = requestIdFromResponse(res);
    throw new Error(`Moonshot error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
  }

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
  const text = extractTextFromChat(data);
  return { text };
}

