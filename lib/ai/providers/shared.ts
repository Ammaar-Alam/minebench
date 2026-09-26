// Helpers with identical semantics across provider adapters
// Provider-specific variants (error vocabularies, content extraction, base URL
// rules) stay in their own adapter files

import { AsyncLocalStorage } from "node:async_hooks";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";
import {
  mergeCustomRequestBody,
  mergeCustomRequestHeaders,
  type CustomRequestBody,
  type CustomRequestHeaders,
} from "@/lib/ai/customProviderConfig";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export type ProviderRequestPreview = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const previewContext = new AsyncLocalStorage<{ request?: ProviderRequestPreview }>();
const PREVIEW_CAPTURED = "Provider request preview captured";

export function isProviderRequestPreviewCaptured(error: unknown): boolean {
  return error instanceof Error && error.message === PREVIEW_CAPTURED;
}

export async function captureProviderRequest(
  run: () => Promise<unknown>,
): Promise<ProviderRequestPreview> {
  const context: { request?: ProviderRequestPreview } = {};
  try {
    await previewContext.run(context, run);
  } catch (error) {
    if (!isProviderRequestPreviewCaptured(error)) throw error;
  }
  if (!context.request) throw new Error("No provider request could be prepared");
  return context.request;
}

export async function providerFetch(url: string | URL, init: RequestInit): Promise<Response> {
  const context = previewContext.getStore();
  if (context) {
    context.request = {
      url: String(url),
      method: init.method ?? "GET",
      headers: Object.fromEntries(
        [...new Headers(init.headers)].map(([name, value]) => [
          name,
          /authorization|api[-_]?key|cookie|secret|token/i.test(name) ? "[hidden]" : value,
        ]),
      ),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    throw new Error(PREVIEW_CAPTURED);
  }
  return fetch(url, init);
}

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
      res = await providerFetch(params.url, {
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
    if (isProviderRequestPreviewCaptured(err)) throw err;
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
