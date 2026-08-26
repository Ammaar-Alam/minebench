import { extractChatCompletionText, withMaxOutputTokens } from "@/lib/ai/providers/shared";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingHttpHeaders, RequestOptions } from "node:http";
import net from "node:net";
import { attachAbortSignal } from "@/lib/ai/providers/abort";
import {
  resolveCustomApiTarget,
  type ResolvedCustomApiTarget,
} from "@/lib/ai/providers/customApiGuard";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";

type OpenAiCompatibleChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type OpenAiCompatibleChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};


type NodeHttpResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<string | Buffer | Uint8Array>;
};

const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build_response";

function requestIdFromHeaders(headers: Headers): string | null {
  return (
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("NVCF-REQID") ??
    null
  );
}

function headersFromNodeResponse(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(name, item);
      }
      continue;
    }
    if (typeof value === "string") {
      result.set(name, value);
    }
  }
  return result;
}

function chunkToUtf8(chunk: string | Buffer | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

async function readResponseText(body: AsyncIterable<string | Buffer | Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of body) {
    text += chunkToUtf8(chunk);
  }
  return text;
}

async function consumeNodeSseStream(
  body: AsyncIterable<string | Buffer | Uint8Array>,
  onEvent: (evt: { event?: string; data: string }) => void,
): Promise<void> {
  let buffer = "";

  const emitFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    const data = dataLines.join("\n");
    if (!data) return;
    onEvent({ event, data });
  };

  for await (const chunk of body) {
    buffer += chunkToUtf8(chunk);
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      emitFrame(frame);
    }
  }

  if (buffer.trim()) {
    const frames = buffer.split(/\r?\n\r?\n/);
    for (const frame of frames) {
      if (!frame.trim()) continue;
      emitFrame(frame);
    }
  }
}

async function postToResolvedApi(params: {
  target: ResolvedCustomApiTarget;
  apiKey: string;
  body: string;
  signal: AbortSignal;
  stream: boolean;
  onProviderRequest?: () => void;
}): Promise<NodeHttpResponse> {
  return await new Promise<NodeHttpResponse>((resolve, reject) => {
    if (params.signal.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }

    const isHttps = params.target.url.protocol === "https:";
    const port = params.target.url.port
      ? Number.parseInt(params.target.url.port, 10)
      : isHttps
        ? 443
        : 80;
    const options: RequestOptions = {
      method: "POST",
      hostname: params.target.address,
      family: params.target.family,
      port,
      path: `${params.target.url.pathname}${params.target.url.search}`,
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        Accept: params.stream ? "text/event-stream" : "application/json",
        Host: params.target.url.host,
        "Content-Length": Buffer.byteLength(params.body).toString(),
      },
    };

    const cleanup = (abort: () => void) => {
      params.signal.removeEventListener("abort", abort);
    };

    const abort = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      req.destroy(error);
    };

    params.onProviderRequest?.();
    const req = (isHttps
      ? https.request(
          {
            ...options,
            servername: net.isIP(params.target.hostname) === 0 ? params.target.hostname : undefined,
          },
          (res) => {
            res.once("end", () => cleanup(abort));
            res.once("close", () => cleanup(abort));
            resolve({
              status: res.statusCode ?? 0,
              headers: headersFromNodeResponse(res.headers),
              body: res,
            });
          },
        )
      : http.request(options, (res) => {
          res.once("end", () => cleanup(abort));
          res.once("close", () => cleanup(abort));
          resolve({
            status: res.statusCode ?? 0,
            headers: headersFromNodeResponse(res.headers),
            body: res,
          });
        })) as ClientRequest;

    req.once("error", (error) => {
      cleanup(abort);
      reject(error);
    });
    params.signal.addEventListener("abort", abort, { once: true });
    req.write(params.body);
    req.end();
  });
}


function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
    b.includes("max_completion_tokens") ||
    (b.includes("maximum") && b.includes("tokens")) ||
    b.includes("too many tokens") ||
    b.includes("token limit") ||
    b.includes("context length")
  );
}

function looksLikeStructuredOutputUnsupportedError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    (b.includes("response_format") &&
      (b.includes("unsupported") || b.includes("invalid") || b.includes("unknown"))) ||
    (b.includes("json_schema") &&
      (b.includes("unsupported") || b.includes("invalid") || b.includes("unknown"))) ||
    (b.includes("schema") && b.includes("unsupported"))
  );
}

export async function openAiCompatibleGenerateText(params: {
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  maxTokensParameter?: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: string;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  serviceLabel?: string;
  requireStructuredOutput?: boolean;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
  onAcceptedOutputTokens?: (tokens: number) => void;
} & ProviderTelemetryCallbacks): Promise<{ text: string }> {
  const serviceLabel = params.serviceLabel ?? "Custom API";
  const apiKey = params.apiKey ?? process.env.CUSTOM_API_KEY;
  if (!apiKey) throw new Error(`Missing ${serviceLabel} API key`);

  const rawBaseUrl = params.baseUrl ?? process.env.CUSTOM_API_BASE_URL;
  if (!rawBaseUrl) throw new Error(`Missing ${serviceLabel} API server URL`);
  const target = await resolveCustomApiTarget(rawBaseUrl);
  const controller = new AbortController();
  const detachAbort = attachAbortSignal(controller, params.signal);
  const timeout: ReturnType<typeof setTimeout> | null = null;

  let res: NodeHttpResponse | null = null;
  let lastBody = "";
  const maxTokens = params.maxOutputTokens ?? 65_536;
  let selectedTokenBudget: number | null = null;
  let useStructuredOutput = Boolean(params.jsonSchema);

  try {
    for (const tok of tokenBudgetCandidates(maxTokens)) {
      res = await postToResolvedApi({
        target,
        apiKey,
        signal: controller.signal,
        stream: Boolean(params.onDelta),
        onProviderRequest: params.onProviderRequest,
        body: JSON.stringify({
          model: params.modelId,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
          stream: Boolean(params.onDelta),
          ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
          [params.maxTokensParameter ?? "max_tokens"]: tok,
          ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
          ...(useStructuredOutput && params.jsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: VOXEL_BUILD_JSON_SCHEMA_NAME,
                    strict: true,
                    schema: params.jsonSchema,
                  },
                },
              }
            : {}),
        }),
      });
      if (res.status >= 200 && res.status < 300) {
        selectedTokenBudget = tok;
        break;
      }
      selectedTokenBudget = tok;
      lastBody = await readResponseText(res.body).catch(() => "");
      if (res.status === 400 && useStructuredOutput && looksLikeStructuredOutputUnsupportedError(lastBody)) {
        if (params.requireStructuredOutput) break;
        useStructuredOutput = false;
        params.onTrace?.("Custom API structured output rejected; falling back to plain text output for this request.");
        continue;
      }
      if (res.status === 400 && looksLikeTokenLimitError(lastBody)) continue;
      break;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${serviceLabel} request timed out`);
    }
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
    console.error("OpenAI-compatible provider network error", { code });
    throw new Error(`${serviceLabel} request failed`);
  } finally {
    detachAbort();
    if (timeout) clearTimeout(timeout);
  }

  if (!res) {
    throw new Error("Custom API request failed");
  }

  if (res.status < 200 || res.status >= 300) {
    const body = lastBody || (await readResponseText(res.body).catch(() => ""));
    const rid = requestIdFromHeaders(res.headers);
    throw new Error(`${serviceLabel} error ${res.status}${rid ? ` (request ${rid})` : ""}: ${body}`);
  }

  const budget = selectedTokenBudget ?? maxTokens;
  params.onAcceptedOutputTokens?.(budget);
  params.onAcceptedRequestConfiguration?.({
    apiMode: "chat_completions",
    maxOutputTokens: budget,
    thinkingMode: params.reasoningEffort
      ? `reasoning=${params.reasoningEffort}`
      : "default",
    temperature: params.temperature ?? "default",
    textVerbosity: "default",
    responseFormat: useStructuredOutput ? "json_schema" : "text",
  });
  params.onTrace?.(
    withMaxOutputTokens(
      useStructuredOutput
        ? `${serviceLabel} chat completions in use with structured output.`
        : `${serviceLabel} chat completions in use without structured output.`,
      budget,
    ),
  );

  if (params.onDelta) {
    let text = "";
    await consumeNodeSseStream(res.body, (evt) => {
      if (evt.data === "[DONE]") return;
      let parsed: OpenAiCompatibleChatStreamChunk | null = null;
      try {
        parsed = JSON.parse(evt.data) as OpenAiCompatibleChatStreamChunk;
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

  const data = JSON.parse(await readResponseText(res.body)) as OpenAiCompatibleChatResponse;
  const text = extractChatCompletionText(data);
  return { text };
}
