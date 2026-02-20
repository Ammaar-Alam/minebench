import { VOXEL_BUILD_JSON_SCHEMA_NAME } from "@/lib/ai/voxelBuildJsonSchema";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";

type OpenAIChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type OpenAIResponsesResponse = {
  output_text?: unknown;
  output?: unknown;
};

type OpenAIBackgroundStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

type OpenAIResponsesBackgroundResponse = OpenAIResponsesResponse & {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  incomplete_details?: unknown;
};

type OpenAIResponsesStreamEvent = {
  type?: unknown;
  delta?: unknown;
};

type OpenAIChatCompletionsStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return defaultValue;
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(0, Math.floor(parsed));
}

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

function backgroundStatusOf(value: unknown): OpenAIBackgroundStatus | null {
  if (value === "queued" || value === "in_progress" || value === "completed" || value === "failed" || value === "cancelled" || value === "incomplete") {
    return value;
  }
  return null;
}

function isBackgroundPending(status: OpenAIBackgroundStatus | null): boolean {
  return status === "queued" || status === "in_progress";
}

function summarizeBackgroundError(data: OpenAIResponsesBackgroundResponse): string | null {
  const errorObj = data.error;
  if (errorObj && typeof errorObj === "object") {
    const message = (errorObj as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const incomplete = data.incomplete_details;
  if (incomplete && typeof incomplete === "object") {
    const reason = (incomplete as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
  }
  return null;
}

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isTransportTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const cause = err instanceof Error && err.cause ? String(err.cause).toLowerCase() : "";
  return (
    msg.includes("und_err_headers_timeout") ||
    msg.includes("headerstimeouterror") ||
    msg.includes("headers timeout") ||
    cause.includes("und_err_headers_timeout") ||
    cause.includes("headerstimeouterror") ||
    cause.includes("headers timeout")
  );
}

function requestTimeoutMs(modelId: string): number {
  const globalOverrideMs = parseIntEnv("OPENAI_REQUEST_TIMEOUT_MS", 0);
  if (globalOverrideMs > 0) return globalOverrideMs;
  if (modelId === "gpt-5.2-pro") {
    const proOverrideMs = parseIntEnv("OPENAI_GPT5_PRO_TIMEOUT_MS", 0);
    if (proOverrideMs > 0) return proOverrideMs;
    return 7_200_000;
  }
  return 1_800_000;
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
      // A headers-timeout can still represent a billed upstream run; avoid
      // duplicating spend by retrying the same request automatically.
      if (isTransportTimeoutError(e)) throw e;
      if (i === opts.tries - 1) throw e;
      const delay = Math.min(opts.maxDelayMs, opts.minDelayMs * Math.pow(2, i));
      await sleepMs(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenAI request failed");
}

async function pollBackgroundResponse(opts: {
  apiKey: string;
  responseId: string;
  signal: AbortSignal;
  pollIntervalMs: number;
}): Promise<OpenAIResponsesBackgroundResponse> {
  let current: OpenAIResponsesBackgroundResponse = { id: opts.responseId, status: "queued" };
  let status = backgroundStatusOf(current.status);

  while (isBackgroundPending(status)) {
    if (opts.pollIntervalMs > 0) await sleepMs(opts.pollIntervalMs);

    const res = await fetchWithRetry(
      `https://api.openai.com/v1/responses/${encodeURIComponent(opts.responseId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: opts.signal,
      },
      { tries: 3, minDelayMs: 400, maxDelayMs: 2000 },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const rid = requestIdFromResponse(res);
      throw new Error(
        `OpenAI background poll error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`,
      );
    }

    current = (await res.json()) as OpenAIResponsesBackgroundResponse;
    status = backgroundStatusOf(current.status);
  }

  return current;
}

type ReasoningConfigAttempt =
  | { kind: "effort"; effort: string }
  | { kind: "max_tokens"; maxTokens: number }
  | undefined;

function reasoningConfigFallbacks(opts: {
  efforts?: string[];
  maxTokens?: number;
}): ReasoningConfigAttempt[] {
  const out: ReasoningConfigAttempt[] = [];

  const normalizedEfforts = (opts.efforts ?? [])
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const uniqueEfforts: string[] = [];
  for (const effort of normalizedEfforts) {
    if (!uniqueEfforts.includes(effort)) uniqueEfforts.push(effort);
  }
  for (const effort of uniqueEfforts) out.push({ kind: "effort", effort });

  const maxTokens = Number(opts.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    out.push({ kind: "max_tokens", maxTokens: Math.floor(maxTokens) });
  }

  out.push(undefined);
  return out;
}

function describeReasoningConfigAttempt(
  cfg: ReasoningConfigAttempt,
  completionBudget: number,
): string {
  if (!cfg) return "disabled";
  if (cfg.kind === "effort") return cfg.effort;
  return `max_tokens=${clampReasoningBudget(cfg.maxTokens, completionBudget)}`;
}

function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}

function clampReasoningBudget(maxTokens: number, completionBudget: number): number {
  const cap = Math.max(1, Math.floor(completionBudget) - 1);
  return Math.max(1, Math.min(Math.floor(maxTokens), cap));
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

function looksLikeReasoningConfigError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    (b.includes("reasoning") &&
      b.includes("effort") &&
      (b.includes("invalid") || b.includes("unsupported") || b.includes("enum") || b.includes("unknown"))) ||
    (b.includes("reasoning") &&
      b.includes("max_tokens") &&
      (b.includes("invalid") || b.includes("unsupported") || b.includes("unknown"))) ||
    b.includes("only one of \"reasoning.effort\" and \"reasoning.max_tokens\"")
  );
}

export async function openaiGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  reasoningMaxTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  if (!params.jsonSchema) throw new Error("Missing jsonSchema for OpenAI structured output");

  const isGpt5Family = params.modelId.startsWith("gpt-5");
  const isGptOssFamily = params.modelId.startsWith("gpt-oss-");
  // Some models are Responses-only (or otherwise not supported in chat/completions).
  // For these, don't fall back to chat/completions because it hides the real failure cause.
  const isResponsesOnlyModel = params.modelId === "gpt-5.2-pro" || params.modelId === "gpt-5.2-codex";
  const reasoningEffortAttempts: string[] = isGpt5Family
    ? ["xhigh", "high"]
    : isGptOssFamily
      ? ["xhigh", "high", "medium", "low"]
      : [];
  const reasoningConfigAttempts = reasoningConfigFallbacks({
    efforts: reasoningEffortAttempts,
    maxTokens: params.reasoningMaxTokens,
  });
  // gpt-5* currently only supports the default temperature (1). Passing a custom value errors,
  // so we omit the parameter entirely and let the API use the default.
  const temperature = isGpt5Family ? undefined : (params.temperature ?? 0.2);
  const maxOutputTokens = params.maxOutputTokens ?? 32768;
  const streamResponses =
    Boolean(params.onDelta) || parseBooleanEnv("OPENAI_STREAM_RESPONSES", true);
  const useBackgroundMode =
    isResponsesOnlyModel &&
    !params.onDelta &&
    parseBooleanEnv("OPENAI_USE_BACKGROUND_MODE", params.modelId === "gpt-5.2-pro");
  const backgroundPollIntervalMs = parseIntEnv("OPENAI_BACKGROUND_POLL_MS", 2_000);
  const streamForRequest = useBackgroundMode ? false : streamResponses;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs(params.modelId));

  try {
    // Prefer the Responses API (works with modern OpenAI models).
    let res: Response | null = null;
    let lastBody = "";
    let selectedResponsesReasoningLabel: string | null = null;
    let selectedResponsesTokenBudget: number | null = null;
    for (const tok of tokenBudgetCandidates(maxOutputTokens)) {
      for (const [cfgIdx, cfg] of reasoningConfigAttempts.entries()) {
        const reasoning =
          cfg?.kind === "effort"
            ? { effort: cfg.effort }
            : cfg?.kind === "max_tokens"
              ? { max_tokens: clampReasoningBudget(cfg.maxTokens, tok) }
              : undefined;
        const currentReasoningLabel = describeReasoningConfigAttempt(cfg, tok);
        res = await fetchWithRetry(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              ...(streamForRequest ? { Accept: "text/event-stream" } : {}),
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
              reasoning,
              background: useBackgroundMode || undefined,
              store: useBackgroundMode || undefined,
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
              stream: streamForRequest,
            }),
          },
          { tries: 3, minDelayMs: 400, maxDelayMs: 2000 },
        );

        if (res.ok) {
          selectedResponsesReasoningLabel = currentReasoningLabel;
          selectedResponsesTokenBudget = tok;
          break;
        }
        lastBody = await res.text().catch(() => "");
        if (res.status === 400 && looksLikeTokenLimitError(lastBody)) break;
        if (res.status === 400 && cfgIdx < reasoningConfigAttempts.length - 1 && looksLikeReasoningConfigError(lastBody)) {
          const nextReasoningLabel = describeReasoningConfigAttempt(
            reasoningConfigAttempts[cfgIdx + 1],
            tok,
          );
          params.onTrace?.(
            `OpenAI Responses reasoning config '${currentReasoningLabel}' rejected (HTTP ${res.status}); falling back to '${nextReasoningLabel}'.`,
          );
          continue;
        }
        break;
      }

      if (res?.ok) break;
      if (res && res.status === 400 && looksLikeTokenLimitError(lastBody)) continue;
      break;
    }

    if (!res) throw new Error("OpenAI request failed");

    if (res.ok) {
      if (selectedResponsesReasoningLabel) {
        const budget = selectedResponsesTokenBudget ?? maxOutputTokens;
        params.onTrace?.(
          withMaxOutputTokens(
            `OpenAI Responses reasoning config in use: '${selectedResponsesReasoningLabel}'.`,
            budget,
          ),
        );
      }
      if (streamForRequest) {
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

      let data = (await res.json()) as OpenAIResponsesBackgroundResponse;
      if (useBackgroundMode) {
        const initialStatus = backgroundStatusOf(data.status);
        const responseId = typeof data.id === "string" ? data.id : null;
        if (isBackgroundPending(initialStatus)) {
          if (!responseId) throw new Error("OpenAI background response missing id");
          data = await pollBackgroundResponse({
            apiKey,
            responseId,
            signal: controller.signal,
            pollIntervalMs: backgroundPollIntervalMs,
          });
        }

        const finalStatus = backgroundStatusOf(data.status);
        if (finalStatus && finalStatus !== "completed") {
          const reason = summarizeBackgroundError(data);
          throw new Error(
            `OpenAI background response ended with status ${finalStatus}${reason ? `: ${reason}` : ""}`,
          );
        }
      }

      const text = extractTextFromResponses(data);
      if (text) return { text };
      if (useBackgroundMode) {
        const finalStatus = backgroundStatusOf(data.status);
        throw new Error(
          `OpenAI background response returned no output text${finalStatus ? ` (status ${finalStatus})` : ""}`,
        );
      }
    } else {
      const body = lastBody || (await res.text().catch(() => ""));
      const rid = requestIdFromResponse(res);
      // Responses-only models: chat/completions will always fail
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
    console.error("OpenAI network error:", err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`OpenAI request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  } finally {
    clearTimeout(timeout);
  }

  if (isResponsesOnlyModel) {
    throw new Error(`OpenAI model ${params.modelId} only supports the /v1/responses endpoint`);
  }

  let res: Response | null = null;
  let lastBody = "";
  let selectedChatEffortLabel: string | null = null;
  let selectedChatTokenBudget: number | null = null;
  for (const tok of tokenBudgetCandidates(maxOutputTokens)) {
    let tryLowerTokenBudget = false;
    const effortAttempts = reasoningEffortAttempts.length > 0 ? [...reasoningEffortAttempts, undefined] : [undefined];
    for (const [effortIdx, effort] of effortAttempts.entries()) {
      const currentEffortLabel = effort ?? "disabled";
      res = await fetchWithRetry(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(streamResponses ? { Accept: "text/event-stream" } : {}),
          },
          body: JSON.stringify({
            model: params.modelId,
            temperature,
            max_completion_tokens: tok,
            reasoning_effort: effort,
            stream: streamResponses,
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
      if (res.ok) {
        selectedChatEffortLabel = currentEffortLabel;
        selectedChatTokenBudget = tok;
        break;
      }
      lastBody = await res.text().catch(() => "");
      if (res.status === 400 && looksLikeTokenLimitError(lastBody)) {
        tryLowerTokenBudget = true;
        break;
      }
      if (res.status === 400 && effortIdx < effortAttempts.length - 1 && looksLikeReasoningConfigError(lastBody)) {
        const nextEffortLabel = effortAttempts[effortIdx + 1] ?? "disabled";
        params.onTrace?.(
          `OpenAI Chat reasoning config '${currentEffortLabel}' rejected (HTTP ${res.status}); falling back to '${nextEffortLabel}'.`,
        );
        continue;
      }
      break;
    }

    if (res?.ok) break;
    if (tryLowerTokenBudget) continue;
    break;
  }

  if (!res) throw new Error("OpenAI request failed");

  if (res.ok && selectedChatEffortLabel) {
    const budget = selectedChatTokenBudget ?? maxOutputTokens;
    params.onTrace?.(
      withMaxOutputTokens(
        `OpenAI Chat reasoning config in use: '${selectedChatEffortLabel}'.`,
        budget,
      ),
    );
  }

  if (res.ok && streamResponses) {
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
