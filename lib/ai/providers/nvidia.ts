import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingHttpHeaders, RequestOptions } from "node:http";
import net from "node:net";
import { attachAbortSignal } from "@/lib/ai/providers/abort";
import { tokenBudgetCandidates } from "@/lib/ai/tokenBudgets";

type NvidiaChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

type NvidiaChatStreamChunk = {
  choices?: { delta?: { content?: unknown } }[];
};

type ResolvedCustomApiTarget = {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
};

type NodeHttpResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<string | Buffer | Uint8Array>;
};

const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build_response";

function extractTextFromChat(data: NvidiaChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => String(c ?? "")).join("");
  return "";
}

function requestIdFromHeaders(headers: Headers): string | null {
  return (
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("NVCF-REQID") ??
    null
  );
}

function normalizeBaseUrl(raw?: string): string {
  const candidate = raw ?? process.env.CUSTOM_API_BASE_URL;
  if (!candidate) {
    throw new Error("Missing custom API server URL");
  }
  const base = candidate
    .trim()
    .replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) {
    return base.slice(0, -"/chat/completions".length);
  }
  return base;
}

function buildChatCompletionsUrl(raw?: string): URL {
  const base = normalizeBaseUrl(raw);
  return new URL(base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`);
}

function normalizeIpAddress(address: string): string {
  const normalized = address.trim().replace(/^\[(.*)\]$/, "$1");
  const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(normalized);
  if (embeddedIpv4) {
    return embeddedIpv4;
  }
  return normalized;
}

function expandIpv6Hextets(address: string): string[] | null {
  const normalized = address.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (net.isIP(normalized) !== 6) return null;

  let candidate = normalized;
  if (candidate.includes(".")) {
    const lastColon = candidate.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4Part = candidate.slice(lastColon + 1);
    if (net.isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    candidate = `${candidate.slice(0, lastColon)}:${high}:${low}`;
  }

  const hasCompression = candidate.includes("::");
  if (hasCompression && candidate.indexOf("::") !== candidate.lastIndexOf("::")) {
    return null;
  }

  const [leftRaw = "", rightRaw = ""] = candidate.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const isHex = (part: string) => /^[0-9a-f]{1,4}$/.test(part);
  if (left.some((part) => !isHex(part)) || right.some((part) => !isHex(part))) {
    return null;
  }

  if (!hasCompression) {
    if (left.length !== 8) return null;
    return left.map((part) => part.padStart(4, "0"));
  }

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [
    ...left.map((part) => part.padStart(4, "0")),
    ...Array.from({ length: missing }, () => "0000"),
    ...right.map((part) => part.padStart(4, "0")),
  ];
}

function extractEmbeddedIpv4FromIpv6(address: string): string | null {
  const hextets = expandIpv6Hextets(address);
  if (!hextets) return null;

  const isCompatible =
    hextets.slice(0, 6).every((part) => part === "0000");
  const isMapped =
    hextets.slice(0, 5).every((part) => part === "0000") && hextets[5] === "ffff";
  if (!isCompatible && !isMapped) return null;

  const high = Number.parseInt(hextets[6], 16);
  const low = Number.parseInt(hextets[7], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isDisallowedIpAddress(address: string): boolean {
  const normalizedAddress = normalizeIpAddress(address);
  const family = net.isIP(normalizedAddress);
  if (family === 4) {
    const parts = normalizedAddress.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && parts[2] === 100) ||
      (a === 203 && b === 0 && parts[2] === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = normalizedAddress.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8")
    );
  }
  return true;
}

function isDnsLookupError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  return (
    "code" in error &&
    (error.code === "ENOTFOUND" ||
      error.code === "EAI_AGAIN" ||
      error.code === "ENODATA" ||
      error.code === "ESERVFAIL")
  );
}

async function resolveCustomApiTarget(rawUrl: string): Promise<ResolvedCustomApiTarget> {
  if (!rawUrl.trim()) {
    throw new Error("Missing custom API server URL");
  }

  let url: URL;
  try {
    url = buildChatCompletionsUrl(rawUrl);
  } catch {
    throw new Error("Invalid custom API server URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Custom API server URL must use http or https");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Custom API server URL must use https in production");
  }
  if (url.username || url.password) {
    throw new Error("Custom API server URL must not include embedded credentials");
  }

  const hostname = normalizeIpAddress(url.hostname.trim().toLowerCase());
  if (!hostname) {
    throw new Error("Custom API server URL is missing a hostname");
  }
  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Custom API server URL must not target localhost or local network hosts");
  }
  if (!hostname.includes(".") && net.isIP(hostname) === 0) {
    throw new Error("Custom API server URL must use a public hostname");
  }

  const hostFamily = net.isIP(hostname);
  if (hostFamily !== 0) {
    const normalizedAddress = normalizeIpAddress(hostname);
    if (isDisallowedIpAddress(normalizedAddress)) {
      throw new Error("Custom API server URL must not target private or loopback IPs");
    }
    return {
      url,
      hostname,
      address: normalizedAddress,
      family: net.isIP(normalizedAddress) as 4 | 6,
    };
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new Error("Custom API server URL hostname did not resolve");
    }

    const normalizedRecords = records.map((record) => ({
      address: normalizeIpAddress(record.address),
      family: net.isIP(normalizeIpAddress(record.address)),
    }));
    if (normalizedRecords.some((record) => record.family === 0 || isDisallowedIpAddress(record.address))) {
      throw new Error("Custom API server URL resolved to a private or loopback address");
    }

    const selected = normalizedRecords[0];
    if (!selected) {
      throw new Error("Custom API server URL hostname did not resolve");
    }

    return {
      url,
      hostname,
      address: selected.address,
      family: selected.family as 4 | 6,
    };
  } catch (error) {
    if (isDnsLookupError(error)) {
      throw new Error("Custom API server URL hostname did not resolve");
    }
    if (error instanceof Error) throw error;
    throw new Error("Failed to validate custom API server URL");
  }
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

export async function assertSafeCustomApiUrl(rawUrl: string): Promise<void> {
  await resolveCustomApiTarget(rawUrl);
}

function looksLikeTokenLimitError(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("max_tokens") ||
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

function withMaxOutputTokens(message: string, maxOutputTokens: number): string {
  const budget = Math.floor(maxOutputTokens);
  const trimmed = message.trim().replace(/[.!?]$/, "");
  return `${trimmed}; max_output_tokens=${budget}.`;
}

export async function openAiCompatibleGenerateText(params: {
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  serviceLabel?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onTrace?: (message: string) => void;
}): Promise<{ text: string }> {
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
        body: JSON.stringify({
          model: params.modelId,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
          stream: Boolean(params.onDelta),
          temperature: params.temperature ?? 0.2,
          max_tokens: tok,
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
    console.error(`${serviceLabel} network error:`, err);
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(`${serviceLabel} request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
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
      let parsed: NvidiaChatStreamChunk | null = null;
      try {
        parsed = JSON.parse(evt.data) as NvidiaChatStreamChunk;
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

  const data = JSON.parse(await readResponseText(res.body)) as NvidiaChatResponse;
  const text = extractTextFromChat(data);
  return { text };
}
