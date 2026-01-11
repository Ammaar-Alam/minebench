import { consumeSseStream } from "@/lib/ai/providers/sse";

type AnthropicMessageResponse = {
  content?: { type?: string; text?: string }[];
};

type AnthropicStreamEvent = {
  type?: unknown;
  delta?: { type?: unknown; text?: unknown } | unknown;
};

function tokenFallbacks(requested: number): number[] {
  const vals = [requested, 65536, 32768, 16384, 8192]
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  const uniq: number[] = [];
  for (const v of vals) if (!uniq.includes(v)) uniq.push(v);
  return uniq;
}

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit")
  );
}

function parseThinkingBudget(): number | null {
  const raw = process.env.ANTHROPIC_THINKING_BUDGET;
  if (!raw) return null;
  const val = Number(raw);
  if (!Number.isFinite(val)) return null;
  const budget = Math.floor(val);
  if (budget < 1024) return null;
  return budget;
}

function isSonnetOrOpus45(modelId: string): boolean {
  return modelId.startsWith("claude-sonnet-4-5") || modelId.startsWith("claude-opus-4-5");
}

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

  const maxTokens = Number.isFinite(params.maxTokens) ? Math.floor(params.maxTokens) : 8192;
  const thinkingBudget = isSonnetOrOpus45(params.modelId)
    ? Math.max(1024, maxTokens - 1)
    : parseThinkingBudget();

  let res: Response | null = null;
  let lastBody = "";
  try {
    for (const tok of tokenFallbacks(maxTokens)) {
      const budget =
        typeof thinkingBudget === "number" ? Math.min(thinkingBudget, tok - 1) : null;
      const thinking =
        typeof budget === "number" && budget >= 1024
          ? { type: "enabled", budget_tokens: budget }
          : undefined;

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
          max_tokens: tok,
          temperature: params.temperature ?? 0.2,
          system: params.system,
          messages: [{ role: "user", content: params.user }],
          stream: Boolean(params.onDelta),
          ...(thinking ? { thinking } : {}),
        }),
      });

      if (res.ok) break;
      lastBody = await res.text().catch(() => "");
      if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue;
      break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Anthropic request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res) throw new Error("Anthropic request failed");

  if (!res.ok) {
    const body = lastBody || (await res.text().catch(() => ""));
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
  return { text };
}
