import { consumeSseStream } from "@/lib/ai/providers/sse";

type OpenRouterChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type OpenRouterStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

function extractTextFromChatCompletions(data: OpenRouterChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function tokenFallbacks(requested: number): number[] {
  const vals = [requested, 65536, 32768, 16384, 8192, 4096, 2048]
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  const uniq: number[] = [];
  for (const v of vals) if (!uniq.includes(v)) uniq.push(v);
  return uniq;
}

function reasoningEffortFallbacks(requested: string[] | undefined): (string | undefined)[] {
  if (!requested || requested.length === 0) return [undefined];
  const normalized = requested
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const uniq: string[] = [];
  for (const v of normalized) if (!uniq.includes(v)) uniq.push(v);
  // Final no-reasoning attempt keeps requests resilient when a routed provider
  // rejects reasoning controls for a specific backend.
  return [...uniq, undefined];
}

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    b.includes("max output tokens") ||
    b.includes("maximum") && b.includes("tokens") ||
    b.includes("too many tokens") ||
    b.includes("token limit") ||
    b.includes("context length")
  );
}

function looksLikeReasoningConfigError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    (b.includes("reasoning") && b.includes("effort") && (b.includes("invalid") || b.includes("unsupported") || b.includes("enum"))) ||
    (b.includes("reasoning") && b.includes("unsupported")) ||
    (b.includes("reasoning") && b.includes("unknown")) ||
    b.includes("only one of \"reasoning.effort\" and \"reasoning.max_tokens\"")
  );
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { tries: number; minDelayMs: number; maxDelayMs: number },
): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i < opts.tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 || res.status === 429) {
        if (i === opts.tries - 1) return res;
        const delay = Math.min(opts.maxDelayMs, opts.minDelayMs * Math.pow(2, i));
        await sleepMs(delay);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i === opts.tries - 1) throw e;
      const delay = Math.min(opts.maxDelayMs, opts.minDelayMs * Math.pow(2, i));
      await sleepMs(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenRouter request failed");
}

export async function openrouterGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffortAttempts?: string[];
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api";
  const maxTokens = params.maxOutputTokens ?? 8192;
  const effortAttempts = reasoningEffortFallbacks(params.reasoningEffortAttempts);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_800_000);

  try {
    let res: Response | null = null;
    let lastBody = "";
    for (const tok of tokenFallbacks(maxTokens)) {
      let tryLowerTokenBudget = false;
      for (const [effortIdx, effort] of effortAttempts.entries()) {
        res = await fetchWithRetry(
          `${baseUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://minebench.dev",
              "X-Title": "MineBench",
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
              reasoning: effort ? { effort } : undefined,
            }),
          },
          { tries: 3, minDelayMs: 400, maxDelayMs: 2000 },
        );

        if (res.ok) break;
        lastBody = await res.text().catch(() => "");
        if (res.status === 400 && looksLikeTokenLimitError(lastBody)) {
          tryLowerTokenBudget = true;
          break;
        }
        if (res.status === 400 && effortIdx < effortAttempts.length - 1 && looksLikeReasoningConfigError(lastBody)) {
          continue;
        }
        break;
      }

      if (res?.ok) break;
      if (tryLowerTokenBudget) continue;
      break;
    }

    if (!res) throw new Error("OpenRouter request failed");

    if (!res.ok) {
      const body = lastBody || (await res.text().catch(() => ""));
      throw new Error(`OpenRouter error ${res.status}: ${body}`);
    }

    if (params.onDelta) {
      let text = "";
      await consumeSseStream(res, (evt) => {
        if (evt.data === "[DONE]") return;
        let parsed: OpenRouterStreamChunk | null = null;
        try {
          parsed = JSON.parse(evt.data) as OpenRouterStreamChunk;
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

    const data = (await res.json()) as OpenRouterChatResponse;
    return { text: extractTextFromChatCompletions(data) };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("OpenRouter request timed out");
    }
    console.error("OpenRouter network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    clearTimeout(timeout);
  }
}
