import { VOXEL_BUILD_JSON_SCHEMA_NAME } from "@/lib/ai/voxelBuildJsonSchema";
import { consumeSseStream } from "@/lib/ai/providers/sse";

type OpenAIChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type OpenAIResponsesResponse = {
  output_text?: unknown;
  output?: unknown;
};

type OpenAIResponsesStreamEvent = {
  type?: unknown;
  delta?: unknown;
};

type OpenAIChatCompletionsStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

function extractTextFromChatCompletions(data: OpenAIChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function extractTextFromResponses(data: OpenAIResponsesResponse): string {
  if (typeof data.output_text === "string") return data.output_text;
  if (data.output_text != null) {
    try {
      return JSON.stringify(data.output_text);
    } catch {
      // ignore
    }
  }
  if (!Array.isArray(data.output)) return "";

  let text = "";
  for (const item of data.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const t = (part as { text?: unknown }).text;
      if (typeof t === "string") text += t;
    }
  }
  return text;
}

function requestIdFromResponse(res: Response): string | null {
  return (
    res.headers.get("x-request-id") ??
    res.headers.get("request-id") ??
    res.headers.get("x-openai-request-id") ??
    null
  );
}

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
  throw lastErr instanceof Error ? lastErr : new Error("OpenAI request failed");
}

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
    b.includes("max_output_tokens") ||
    b.includes("max_completion_tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit")
  );
}

export async function openaiGenerateText(params: {
  modelId: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  onDelta?: (delta: string) => void;
}): Promise<{ text: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  if (!params.jsonSchema) throw new Error("Missing jsonSchema for OpenAI structured output");

  const isGpt5Family = params.modelId.startsWith("gpt-5");
  const isResponsesOnlyModel = params.modelId === "gpt-5.2-codex";
  const useHighReasoning =
    params.modelId === "gpt-5.2" || params.modelId === "gpt-5.2-pro" || isGpt5Family;
  // gpt-5* currently only supports the default temperature (1). Passing a custom value errors,
  // so we omit the parameter entirely and let the API use the default.
  const temperature = isGpt5Family ? undefined : (params.temperature ?? 0.2);
  const maxOutputTokens = params.maxOutputTokens ?? 32768;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    // Prefer the Responses API (works with modern OpenAI models).
    let res: Response | null = null;
    let lastBody = "";
    for (const tok of tokenFallbacks(maxOutputTokens)) {
      res = await fetchWithRetry(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(params.onDelta ? { Accept: "text/event-stream" } : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: params.modelId,
            input: [
              {
                role: "system",
                content: [{ type: "input_text", text: params.system }],
              },
              {
                role: "user",
                content: [{ type: "input_text", text: params.user }],
              },
            ],
            reasoning: useHighReasoning ? { effort: "high" } : undefined,
            text: {
              format: {
                type: "json_schema",
                name: VOXEL_BUILD_JSON_SCHEMA_NAME,
                strict: true,
                schema: params.jsonSchema,
              },
            },
            temperature,
            max_output_tokens: tok,
            stream: Boolean(params.onDelta),
          }),
        },
        { tries: 3, minDelayMs: 400, maxDelayMs: 2000 },
      );

      if (res.ok) break;
      lastBody = await res.text().catch(() => "");
      if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue;
      break;
    }

    if (!res) throw new Error("OpenAI request failed");

    if (res.ok) {
      if (params.onDelta) {
        let text = "";
        await consumeSseStream(res, (evt) => {
          if (evt.data === "[DONE]") return;
          let parsed: OpenAIResponsesStreamEvent | null = null;
          try {
            parsed = JSON.parse(evt.data) as OpenAIResponsesStreamEvent;
          } catch {
            return;
          }
          if (parsed?.type === "response.output_text.delta" && typeof parsed.delta === "string") {
            const delta = parsed.delta;
            if (delta) {
              text += delta;
              params.onDelta?.(delta);
            }
          }
        });
        if (text) return { text };
      }

      const data = (await res.json()) as OpenAIResponsesResponse;
      const text = extractTextFromResponses(data);
      if (text) return { text };
    } else {
      const body = lastBody || (await res.text().catch(() => ""));
      const rid = requestIdFromResponse(res);
      // gpt-5.2-codex is Responses-only; chat/completions will always fail
      if (isResponsesOnlyModel) {
        throw new Error(`OpenAI error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
      }

      // Fall back for environments/models that still require chat/completions.
      if (res.status !== 404 && res.status !== 400) {
        throw new Error(`OpenAI error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
      }
    }
  } catch (err) {
    // If Responses fails (unsupported endpoint/model), try chat/completions below.
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("OpenAI request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (isResponsesOnlyModel) {
    throw new Error("OpenAI model gpt-5.2-codex only supports the /v1/responses endpoint");
  }

  let res: Response | null = null;
  let lastBody = "";
  for (const tok of tokenFallbacks(maxOutputTokens)) {
    res = await fetchWithRetry(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(params.onDelta ? { Accept: "text/event-stream" } : {}),
        },
        body: JSON.stringify({
          model: params.modelId,
          temperature,
          max_completion_tokens: tok,
          reasoning_effort: useHighReasoning ? "high" : undefined,
          stream: Boolean(params.onDelta),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: VOXEL_BUILD_JSON_SCHEMA_NAME,
              strict: true,
              schema: params.jsonSchema,
            },
          },
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
        }),
      },
      { tries: 3, minDelayMs: 400, maxDelayMs: 2000 },
    );
    if (res.ok) break;
    lastBody = await res.text().catch(() => "");
    if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue;
    break;
  }

  if (!res) throw new Error("OpenAI request failed");

  if (res.ok && params.onDelta) {
    let text = "";
    await consumeSseStream(res, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: OpenAIChatCompletionsStreamChunk | null = null;
      try {
        parsed = JSON.parse(evt.data) as OpenAIChatCompletionsStreamChunk;
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

  if (!res.ok) {
    const body = lastBody || (await res.text().catch(() => ""));
    // Some models/environments may not support response_format. Retry once without it.
    if (res.status === 400) {
      const retry = await fetchWithRetry(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: params.modelId,
            temperature,
            max_completion_tokens: maxOutputTokens,
            stream: false,
            messages: [
              { role: "system", content: params.system },
              { role: "user", content: params.user },
            ],
          }),
        },
        { tries: 3, minDelayMs: 400, maxDelayMs: 2000 },
      );

      if (!retry.ok) {
        const retryBody = await retry.text().catch(() => "");
        const rid = requestIdFromResponse(retry);
        throw new Error(
          `OpenAI error ${retry.status}${rid ? ` (request ${rid})` : ""}: ${retryBody || body}`,
        );
      }

      const retryData = (await retry.json()) as OpenAIChatResponse;
      const retryText = extractTextFromChatCompletions(retryData);
      if (params.onDelta) params.onDelta(retryText);
      return { text: retryText };
    }

    const rid = requestIdFromResponse(res);
    throw new Error(`OpenAI error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
  }

  const data = (await res.json()) as OpenAIChatResponse;
  const text = extractTextFromChatCompletions(data);
  if (params.onDelta) params.onDelta(text);
  return { text };
}
