// Helpers with identical semantics across provider adapters
// Provider-specific variants (error vocabularies, content extraction, base URL
// rules) stay in their own adapter files

import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";
import {
  mergeCustomRequestBody,
  mergeCustomRequestHeaders,
  type CustomRequestBody,
  type CustomRequestHeaders,
} from "@/lib/ai/customProviderConfig";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return defaultValue;
}

export function requestIdFromResponse(res: Response): string | null {
  return res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? null;
}

export function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}

export function extractChatCompletionText(data: {
  choices?: { message?: { content?: unknown } }[];
}): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => String(c ?? "")).join("");
  return "";
}

// The fetch-based chat-completions scaffold shared by the first-party
// OpenAI-compatible adapters: descend the token-budget ladder on 400
// token-limit rejections, classify aborts/network failures, and surface the
// provider error body with its request id. Request bodies, error
// vocabularies, and stream handling stay in the adapters.
export async function postChatCompletionWithTokenBudgetRetry(params: {
  serviceLabel: string;
  url: string;
  apiKey: string;
  maxOutputTokens: number;
  stream: boolean;
  looksLikeTokenLimitError: (body: string) => boolean;
  buildBody: (tokenBudget: number) => Record<string, unknown>;
  customHeaders?: CustomRequestHeaders;
  customBody?: CustomRequestBody;
  signal?: AbortSignal;
  onProviderRequest?: () => void;
}): Promise<{ res: Response; acceptedTokenBudget: number }> {
  let res: Response | null = null;
  let lastBody = "";
  let selectedTokenBudget: number | null = null;
  try {
    for (const tok of tokenBudgetCandidates(params.maxOutputTokens)) {
      params.signal?.throwIfAborted();
      params.onProviderRequest?.();
      // Fetch keeps this signal attached to the returned response body
      res = await fetch(params.url, {
        method: "POST",
        headers: mergeCustomRequestHeaders({
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
          ...(params.stream ? { Accept: "text/event-stream" } : {}),
        }, params.customHeaders),
        signal: params.signal,
        body: JSON.stringify(mergeCustomRequestBody(params.buildBody(tok), params.customBody)),
      });
      if (res.ok) {
        selectedTokenBudget = tok;
        break;
      }
      lastBody = await res.text().catch(() => "");
      if (res.status === 400 && params.looksLikeTokenLimitError(lastBody)) continue;
      break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${params.serviceLabel} request timed out`);
    }
    console.error(`${params.serviceLabel} network error:`, err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(
      `${params.serviceLabel} request failed: ${err instanceof Error ? err.message : String(err)}${cause}`,
    );
  }

  if (!res) {
    throw new Error(`${params.serviceLabel} request failed`);
  }

  if (!res.ok) {
    const body = lastBody || (await res.text().catch(() => ""));
    const rid = requestIdFromResponse(res);
    throw new Error(
      `${params.serviceLabel} error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`,
    );
  }

  return { res, acceptedTokenBudget: selectedTokenBudget ?? params.maxOutputTokens };
}
