import { consumeSseStream } from "@/lib/ai/providers/sse";

type AnthropicMessageResponse = {
  content?: { type?: string; text?: string }[];
};

type AnthropicStreamEvent = {
  type?: unknown;
  delta?: { type?: unknown; text?: unknown } | unknown;
};

export async function anthropicGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(params.onDelta ? { Accept: "text/event-stream" } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: params.modelId,
        max_tokens: params.maxTokens,
        temperature: params.temperature ?? 0.2,
        system: params.system,
        messages: [{ role: "user", content: params.user }],
        stream: Boolean(params.onDelta),
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Anthropic request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic error ${res.status}: ${body}`);
  }

  if (params.onDelta) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: AnthropicStreamEvent | null = null;
      try {
        parsed = JSON.parse(evt.data) as AnthropicStreamEvent;
      } catch {
        return;
      }
      // message streaming sends incremental deltas on content_block_delta
      if (parsed?.type === "content_block_delta") {
        const deltaObj = parsed.delta as { text?: unknown } | undefined;
        const chunk = deltaObj && typeof deltaObj.text === "string" ? deltaObj.text : "";
        if (chunk) {
          text += chunk;
          params.onDelta?.(chunk);
        }
      }
    });
    return { text };
  }

  const data = (await res.json()) as AnthropicMessageResponse;
  const text =
    data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("") ?? "";
  if (params.onDelta) params.onDelta(text);
  return { text };
}
