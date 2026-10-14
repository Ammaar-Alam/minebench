import { isProviderRequestPreviewCaptured, providerFetch, withMaxOutputTokens } from "@/lib/ai/providers/shared";
import { attachAbortSignal } from "@/lib/ai/providers/abort";
import { consumeSseStream } from "@/lib/ai/providers/sse";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";
import { modelUsesDefaultSampling } from "@/lib/ai/modelRequestProfiles";
import type { GeminiThinkingConfig } from "@/lib/ai/reasoningProfiles";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";
import {
  mergeCustomRequestBody,
  mergeCustomRequestHeaders,
  type CustomRequestBody,
  type CustomRequestHeaders,
} from "@/lib/ai/customProviderConfig";

type JsonSchema = Record<string, unknown>;

const GEMINI_SUPPORTED_JSON_SCHEMA_KEYS = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

export function sanitizeGeminiJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiJsonSchema);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!GEMINI_SUPPORTED_JSON_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" || key === "$defs") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      output[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([name, schema]) => [
          name,
          sanitizeGeminiJsonSchema(schema),
        ]),
      );
      continue;
    }
    output[key] = sanitizeGeminiJsonSchema(entry);
  }
  return output;
}

type GeminiCandidate = {
  content?: { parts?: { text?: string; thought?: boolean }[] };
  finishReason?: string;
  continuationToken?: string;
};

type GeminiGenerateContentResponse = {
  candidates?: GeminiCandidate[];
  error?: unknown;
};

function geminiRequestError(err: unknown): unknown {
  if (isProviderRequestPreviewCaptured(err)) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new Error("Gemini request timed out");
  }
  console.error("Gemini network error:", err);
  const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
  return new Error(`Gemini request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
}

function bestThinkingConfigForModel(modelId: string): GeminiThinkingConfig | undefined {
  if (modelId.startsWith("gemini-3")) {
    return { thinkingLevel: "high" };
  }

  if (modelId.startsWith("gemma-4")) {
    return { thinkingLevel: "high" };
  }

  if (modelId.startsWith("gemini-2.5-pro")) {
    // Use adaptive/dynamic reasoning budget for 2.5 Pro.
    return { thinkingBudget: -1 };
  }

  return undefined;
}

function usesDefaultSampling(modelId: string): boolean {
  return modelId.startsWith("gemini-3") || modelUsesDefaultSampling(modelId);
}

function describeThinkingConfigLine(thinkingConfig?: GeminiThinkingConfig): string {
  if (thinkingConfig?.thinkingLevel) {
    return `Gemini thinking level in use: '${thinkingConfig.thinkingLevel}'.`;
  }
  if (typeof thinkingConfig?.thinkingBudget === "number") {
    return `Gemini thinking budget in use: ${thinkingConfig.thinkingBudget}.`;
  }
  return "Gemini thinking config in use: default.";
}

export async function geminiGenerateText(params: {
  modelId: string;
  apiKey?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  thinkingConfig?: GeminiThinkingConfig;
  temperature?: number;
  jsonSchema?: JsonSchema;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
  onAcceptedOutputTokens?: (tokens: number) => void;
  customHeaders?: CustomRequestHeaders;
  customBody?: CustomRequestBody;
} & ProviderTelemetryCallbacks): Promise<{ text: string }> {
  const apiKey = params.apiKey ?? process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_AI_API_KEY");
  if (!params.jsonSchema) throw new Error("Missing jsonSchema for Gemini JSON mode");

  // Argon can think past undici's 5-minute header and body timeouts, so it
  // streams thought summaries to keep the connection active
  const streamThoughts = params.modelId === "gemini-4-argon";
  const stream = Boolean(params.onDelta) || streamThoughts;
  const method = stream ? "streamGenerateContent" : "generateContent";
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      params.modelId
    )}:${method}`
  );
  url.searchParams.set("key", apiKey);
  if (stream) url.searchParams.set("alt", "sse");

  const controller = new AbortController();
  const detachAbort = attachAbortSignal(controller, params.signal);
  const timeout: ReturnType<typeof setTimeout> | null = null;
  let res: Response | null = null;
  let acceptedRequest: { headers: CustomRequestHeaders; body: Record<string, unknown> } | null = null;
  try {
    const thinkingConfig = params.thinkingConfig ?? bestThinkingConfigForModel(params.modelId);
    const thinkingConfigLine = describeThinkingConfigLine(thinkingConfig);
    const responseJsonSchema = sanitizeGeminiJsonSchema(params.jsonSchema) as JsonSchema;
    const generationConfig = {
      ...(usesDefaultSampling(params.modelId) ? {} : { temperature: params.temperature ?? 0.2 }),
      maxOutputTokens: params.maxOutputTokens ?? 8192,
      ...(thinkingConfig
        ? { thinkingConfig: streamThoughts ? { ...thinkingConfig, includeThoughts: true } : thinkingConfig }
        : {}),
    };
    const basePayload = {
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: "user", parts: [{ text: params.user }] }],
      generationConfig,
    };

    const uniqTokens = tokenBudgetCandidates(basePayload.generationConfig.maxOutputTokens);
    let successBudget = basePayload.generationConfig.maxOutputTokens;
    let lastBody = "";
    for (const tok of uniqTokens) {
      const payload = {
        ...basePayload,
        generationConfig: {
          ...(basePayload.generationConfig as object),
          maxOutputTokens: tok,
          responseMimeType: "application/json",
          responseJsonSchema,
        },
      };
      const headers = mergeCustomRequestHeaders(
        { "Content-Type": "application/json" },
        params.customHeaders,
      );
      if (stream) headers.Accept = "text/event-stream";
      controller.signal.throwIfAborted();
      const body = mergeCustomRequestBody(payload, params.customBody, [
        "generationConfig.responseMimeType",
        "generationConfig.responseJsonSchema",
      ]);
      params.onProviderRequest?.();
      res = await providerFetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (res.ok) {
        successBudget = tok;
        acceptedRequest = { headers, body };
        break;
      }
      lastBody = await res.text().catch(() => "");
      // Retry with smaller token budget if that looks like the issue
      if (res.status === 400 && lastBody.toLowerCase().includes("maxoutputtokens")) continue;
      break;
    }

    if (!res) throw new Error("Gemini request failed");
    if (!res.ok) {
      const body = lastBody || (await res.text().catch(() => ""));
      throw new Error(`Gemini error ${res.status}: ${body}`);
    }

    const budget = successBudget ?? basePayload.generationConfig.maxOutputTokens;
    params.onAcceptedOutputTokens?.(budget);
    params.onAcceptedRequestConfiguration?.({
      apiMode: method,
      maxOutputTokens: budget,
      ...(typeof thinkingConfig?.thinkingBudget === "number"
        ? { reasoningMaxTokens: thinkingConfig.thinkingBudget }
        : {}),
      thinkingMode: thinkingConfig?.thinkingLevel
        ? `thinking_level=${thinkingConfig.thinkingLevel}`
        : typeof thinkingConfig?.thinkingBudget === "number"
          ? `thinking_budget=${thinkingConfig.thinkingBudget}`
          : "default",
      temperature: usesDefaultSampling(params.modelId)
        ? "default"
        : (params.temperature ?? 0.2),
      textVerbosity: "default",
      responseFormat: "json_schema",
    });
    params.onTrace?.(withMaxOutputTokens(thinkingConfigLine, budget));
  } catch (err) {
    detachAbort();
    throw geminiRequestError(err);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (!res || !acceptedRequest) throw new Error("Gemini request failed");

  // Long decode stops each request at the per-request limit with a continuation
  // token, and resending the identical request with it resumes the same output.
  // Streams also send checkpoint tokens, so a dropped stream resumes from the
  // last checkpoint and drops the uncommitted text after it
  let text = "";
  let checkpoint: { token: string; length: number } | undefined;
  let resumesWithoutProgress = 0;
  // Once checkpoints start, deltas wait for their commit so a resume never shows discarded text
  let delivered = 0;
  const deliver = (upTo: number) => {
    if (upTo <= delivered) return;
    params.onDelta?.(text.slice(delivered, upTo));
    delivered = upTo;
  };
  try {
    for (;;) {
      // Terminal fields can arrive on separate events, so each keeps its last value
      let finishReason: string | undefined;
      let hopToken: string | undefined;
      let continuationToken: string | undefined;
      const readAnswer = (data: GeminiGenerateContentResponse): string => {
        if (data.error) throw new Error(`Gemini error: ${JSON.stringify(data.error)}`);
        const candidate = data.candidates?.[0];
        finishReason = candidate?.finishReason ?? finishReason;
        hopToken = candidate?.continuationToken ?? hopToken;
        return candidate?.content?.parts?.map((p) => (p.thought ? "" : p.text ?? "")).join("") ?? "";
      };
      const commit = () => {
        if (!hopToken || hopToken === checkpoint?.token) return;
        checkpoint = { token: hopToken, length: text.length };
        resumesWithoutProgress = 0;
      };

      try {
        if (stream) {
          await consumeSseStream(res, (evt) => {
            if (evt.data === "[DONE]") return;
            const delta = readAnswer(JSON.parse(evt.data) as GeminiGenerateContentResponse);
            text += delta;
            commit();
            deliver(checkpoint ? checkpoint.length : text.length);
          });
        } else {
          text += readAnswer((await res.json()) as GeminiGenerateContentResponse);
          commit();
        }
        if (finishReason === "CONTINUATION") continuationToken = hopToken;
      } catch (err) {
        if (!stream || !checkpoint || controller.signal.aborted || ++resumesWithoutProgress > 2) throw err;
        text = text.slice(0, checkpoint.length);
        continuationToken = checkpoint.token;
      }

      if (!continuationToken) {
        // A stream can close without a final event, which is a cut-off response, not a finished one
        if (stream && finishReason !== "STOP") {
          throw new Error(`Gemini stream ended before completion (finishReason=${finishReason ?? "none"})`);
        }
        if (!text.trim()) {
          throw new Error(`Gemini returned no answer text (finishReason=${finishReason ?? "none"})`);
        }
        deliver(text.length);
        return { text };
      }
      controller.signal.throwIfAborted();
      params.onProviderRequest?.();
      res = await providerFetch(url, {
        method: "POST",
        headers: acceptedRequest.headers,
        signal: controller.signal,
        body: JSON.stringify({ ...acceptedRequest.body, continuationToken }),
      });
      if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (err) {
    throw geminiRequestError(err);
  } finally {
    detachAbort();
  }
}
