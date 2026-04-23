#!/usr/bin/env npx tsx

import "dotenv/config";

type BuildPayloadMode = "adaptive" | "inline" | "shell";
type ArenaBuildVariant = "preview" | "full";

type ArenaBuildRef = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
};

type ArenaBuildLoadHints = {
  initialVariant: ArenaBuildVariant;
  initialDeliveryClass?: string;
  deliveryClass: string;
  fullBlockCount: number;
  previewBlockCount: number;
  initialEstimatedBytes?: number | null;
  fullEstimatedBytes?: number | null;
};

type VoxelBuild = {
  version: string;
  blocks: unknown[];
};

type ArenaMatchupLane = {
  build: VoxelBuild | null;
  buildRef?: ArenaBuildRef;
  previewRef?: ArenaBuildRef;
  buildLoadHints?: ArenaBuildLoadHints;
};

type ArenaMatchup = {
  id: string;
  samplingLane?: string;
  a: ArenaMatchupLane;
  b: ArenaMatchupLane;
};

const USER_BUILD_CACHE_LIMIT = 64;

type BuildVariantResponse = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
  voxelBuild: VoxelBuild | null;
};

type ArenaBuildStreamEvent =
  | {
      type: "hello";
      totalBlocks: number;
    }
  | {
      type: "chunk";
      blocks: unknown[];
      receivedBlocks: number;
      totalBlocks: number;
    }
  | {
      type: "complete";
      totalBlocks: number;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "ping";
      ts: number;
    };

type Args = {
  baseUrl: string;
  users: number;
  durationSeconds: number;
  promptId?: string;
  payload: BuildPayloadMode;
  isolateUserIp: boolean;
  rampMs: number;
  maxActiveRequests: number;
  thinkMs: number;
  matchupRetries: number;
  matchupTimeoutMs: number;
  voteTimeoutMs: number;
  buildTimeoutMs: number;
  detailUpgradeRate: number;
  help: boolean;
};

class RequestError extends Error {
  stage: string;
  timeout: boolean;
  durationMs: number | null;
  responseHeaders: Headers | null;
  statusCode: number | null;
  payloadStatusCode: number | null;
  networkFailure: boolean;
  networkCode: string | null;

  constructor(
    stage: string,
    message: string,
    timeout = false,
    opts?: {
      durationMs?: number | null;
      responseHeaders?: Headers | null;
      statusCode?: number | null;
      payloadStatusCode?: number | null;
      networkFailure?: boolean;
      networkCode?: string | null;
    },
  ) {
    super(message);
    this.name = "RequestError";
    this.stage = stage;
    this.timeout = timeout;
    this.durationMs = opts?.durationMs ?? null;
    this.responseHeaders = opts?.responseHeaders ?? null;
    this.statusCode = opts?.statusCode ?? null;
    this.payloadStatusCode = opts?.payloadStatusCode ?? null;
    this.networkFailure = opts?.networkFailure ?? false;
    this.networkCode = opts?.networkCode ?? null;
  }
}

class CookieJar {
  private cookies = new Map<string, string>();

  apply(headers: Headers) {
    const values = getSetCookieHeaders(headers);
    for (const raw of values) {
      const first = raw.split(";", 1)[0]?.trim();
      if (!first) continue;
      const eqIndex = first.indexOf("=");
      if (eqIndex <= 0) continue;
      const name = first.slice(0, eqIndex).trim();
      const value = first.slice(eqIndex + 1).trim();
      if (!name) continue;
      this.cookies.set(name, value);
    }
  }

  headerValue() {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

class RequestGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.limit > 0 && this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

let requestGate: RequestGate | null = null;

class Metrics {
  private counts = new Map<string, number>();
  private timings = new Map<string, number[]>();
  private errors = new Map<string, number>();
  private startedAt = Date.now();

  increment(name: string, delta = 1) {
    this.counts.set(name, (this.counts.get(name) ?? 0) + delta);
  }

  addTiming(name: string, value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    const bucket = this.timings.get(name);
    if (bucket) {
      bucket.push(value);
      return;
    }
    this.timings.set(name, [value]);
  }

  recordServerTiming(prefix: string, header: string | null) {
    if (!header) return;
    for (const entry of parseServerTiming(header)) {
      this.addTiming(`${prefix}.${entry.name}`, entry.dur);
    }
  }

  recordError(stage: string, error: unknown) {
    if (error instanceof RequestError) {
      if (error.statusCode != null) {
        this.increment("http_failures");
        this.increment(`${stage}_http_failures`);
        this.increment(`http_status_${error.statusCode}`);
        if (error.payloadStatusCode != null) {
          this.increment(`http_payload_status_${error.payloadStatusCode}`);
        }
        if (error.statusCode >= 500) {
          this.increment("http_5xx");
        } else if (error.statusCode >= 400) {
          this.increment("http_4xx");
        } else {
          this.increment("http_other");
        }
      } else if (error.networkFailure || error.timeout) {
        this.increment("network_fetch_failures");
        this.increment(`${stage}_network_fetch_failures`);
        if (error.networkCode) {
          this.increment(`network_fetch_code_${error.networkCode}`);
          this.increment(`${stage}_network_fetch_code_${error.networkCode}`);
        }
        if (error.timeout) {
          this.increment("network_fetch_timeouts");
        }
      }
    }

    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : typeof error === "string" && error.trim()
          ? error.trim()
          : "unknown error";
    const key = `${stage}: ${truncate(message, 180)}`;
    this.errors.set(key, (this.errors.get(key) ?? 0) + 1);
    this.increment("errors");
    if (error instanceof RequestError && error.timeout) {
      this.increment(`${stage}_timeouts`);
    }
  }

  snapshot() {
    return {
      elapsedMs: Date.now() - this.startedAt,
      roundsCompleted: this.counts.get("rounds_completed") ?? 0,
      errors: this.counts.get("errors") ?? 0,
      fullHydrations: this.counts.get("full_hydrations") ?? 0,
      votes: this.counts.get("votes_ok") ?? 0,
    };
  }

  printSummary(args: Args) {
    const lines: string[] = [];
    lines.push("");
    lines.push("Arena load summary");
    lines.push(`- base url: ${args.baseUrl}`);
    lines.push(`- users: ${args.users}`);
    lines.push(`- duration: ${args.durationSeconds}s`);
    lines.push(`- payload mode: ${args.payload}`);
    lines.push(`- ramp: ${args.rampMs}ms`);
    if (args.maxActiveRequests > 0) {
      lines.push(`- max active requests: ${args.maxActiveRequests}`);
    }
    lines.push(`- detail upgrade rate: ${args.detailUpgradeRate}`);
    if (args.isolateUserIp) {
      lines.push("- isolated user ip: enabled");
    }
    if (args.promptId) {
      lines.push(`- forced prompt: ${args.promptId}`);
    }
    lines.push("");

    const countEntries = Array.from(this.counts.entries()).sort(([a], [b]) => a.localeCompare(b));
    if (countEntries.length > 0) {
      lines.push("Counts");
      for (const [name, value] of countEntries) {
        lines.push(`- ${name}: ${value}`);
      }
      lines.push("");
    }

    const timingEntries = Array.from(this.timings.entries()).sort(([a], [b]) => a.localeCompare(b));
    if (timingEntries.length > 0) {
      lines.push("Latency");
      for (const [name, values] of timingEntries) {
        lines.push(
          `- ${name}: count=${values.length} avg=${formatMs(average(values))} p50=${formatMs(percentile(values, 50))} p95=${formatMs(percentile(values, 95))} p99=${formatMs(percentile(values, 99))}`,
        );
      }
      lines.push("");
    }

    const errorEntries = Array.from(this.errors.entries()).sort((a, b) => b[1] - a[1]);
    if (errorEntries.length > 0) {
      lines.push("Top errors");
      for (const [message, count] of errorEntries.slice(0, 12)) {
        lines.push(`- ${count}x ${message}`);
      }
      lines.push("");
    }

    console.log(lines.join("\n").trimEnd());
  }
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function formatMs(value: number) {
  return `${value.toFixed(1)}ms`;
}

function getNetworkErrorDetail(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return null;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : null;
  const message =
    "message" in cause && typeof cause.message === "string" && cause.message.trim()
      ? cause.message.trim()
      : null;
  if (code && message) return `${code}: ${message}`;
  return code ?? message;
}

function getNetworkErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const directCode = "code" in error && typeof error.code === "string" ? error.code : null;
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : null;
  const code = causeCode ?? directCode;
  if (!code) return null;
  return code.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 64);
}

function getPayloadStatusCodeFromText(text: string): number | null {
  if (!text.trim()) return null;
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object") return null;
    const value = (body as Record<string, unknown>).statusCode;
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number.parseInt(value, 10)
          : NaN;
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  } catch {
    return null;
  }
}

function isTransportLikeError(error: unknown): boolean {
  if (error instanceof RequestError) return error.networkFailure || error.timeout;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  if (getNetworkErrorCode(error)) return true;
  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("networkerror") ||
    message.includes("terminated") ||
    message.includes("socket") ||
    message.includes("connection")
  );
}

function parseNumberArg(args: string[], name: string, fallback: number) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const raw = args[index + 1] ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumberArg(args: string[], name: string, fallback: number) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const raw = args[index + 1] ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseStringArg(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const raw = args[index + 1]?.trim();
  return raw ? raw : undefined;
}

function parseFloatArg(args: string[], name: string, fallback: number) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const raw = args[index + 1] ?? "";
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function parseBooleanFlag(
  args: string[],
  name: string,
  envValue: string | undefined,
  fallback: boolean,
) {
  if (args.includes(name)) return true;
  if (!envValue) return fallback;
  const normalized = envValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeBaseUrl(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const payloadRaw = (parseStringArg(args, "--payload") ?? "adaptive").toLowerCase();
  const payload: BuildPayloadMode =
    payloadRaw === "inline" ? "inline" : payloadRaw === "shell" ? "shell" : "adaptive";

  return {
    baseUrl: normalizeBaseUrl(
      parseStringArg(args, "--base-url") ?? process.env.MINEBENCH_LOAD_BASE_URL ?? "http://localhost:3000",
    ),
    users: parseNumberArg(args, "--users", 12),
    durationSeconds: parseNumberArg(args, "--duration", 90),
    promptId: parseStringArg(args, "--prompt-id"),
    payload,
    isolateUserIp: parseBooleanFlag(
      args,
      "--isolate-user-ip",
      process.env.MINEBENCH_LOAD_ISOLATE_USER_IP,
      false,
    ),
    rampMs: parseNonNegativeNumberArg(args, "--ramp-ms", 500),
    maxActiveRequests: parseNonNegativeNumberArg(args, "--max-active-requests", 64),
    thinkMs: parseNumberArg(args, "--think-ms", 150),
    matchupRetries: parseNumberArg(args, "--matchup-retries", 0),
    matchupTimeoutMs: parseNumberArg(args, "--matchup-timeout-ms", 12_000),
    voteTimeoutMs: parseNumberArg(args, "--vote-timeout-ms", 12_000),
    buildTimeoutMs: parseNumberArg(args, "--build-timeout-ms", 35_000),
    detailUpgradeRate: parseFloatArg(args, "--detail-upgrade-rate", 0),
    help,
  };
}

function printHelp() {
  console.log(
    `
Run concurrent MineBench Arena users against a local or deployed app.

Usage:
  pnpm arena:load --base-url http://localhost:3000
  pnpm arena:load --base-url https://your-preview-url --users 12 --duration 90
  pnpm arena:load --base-url https://your-app.vercel.app --users 16 --duration 120

Options:
  --base-url              Arena origin to test
  --users                 Concurrent virtual users
  --duration              Test duration in seconds
  --payload               Matchup payload mode: adaptive, inline, or shell
  --prompt-id             Force a single seeded prompt
  --isolate-user-ip       Opt in to synthetic per-user x-forwarded-for addresses
  --ramp-ms               Spread virtual-user starts over this window
  --max-active-requests   Cap concurrent HTTP requests from this process; 0 disables
  --think-ms              Wait time after both builds finish before voting
  --matchup-retries       Extra retries for matchup GETs after timeout/network failure
  --matchup-timeout-ms    Timeout per matchup request
  --vote-timeout-ms       Timeout per vote request
  --build-timeout-ms      Timeout per full-build hydration
  --detail-upgrade-rate   Chance of upgrading one preview lane to full (0-1)

Env:
  MINEBENCH_LOAD_ISOLATE_USER_IP=1 enables --isolate-user-ip by default
`.trim(),
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function forwardedIpForUser(userIndex: number) {
  const normalized = Math.max(1, userIndex);
  const third = Math.floor((normalized - 1) / 250) % 250;
  const fourth = ((normalized - 1) % 250) + 1;
  return `198.18.${third}.${fourth}`;
}

function getSetCookieHeaders(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === "function") {
    return extended.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function parseServerTiming(header: string) {
  return header
    .split(",")
    .map((segment) => {
      const trimmed = segment.trim();
      if (!trimmed) return null;
      const [name, ...parts] = trimmed.split(";");
      const durPart = parts.find((part) => part.trim().startsWith("dur="));
      const dur = durPart ? Number.parseFloat(durPart.split("=", 2)[1] ?? "") : NaN;
      if (!name || !Number.isFinite(dur)) return null;
      return { name: name.trim(), dur };
    })
    .filter((entry): entry is { name: string; dur: number } => entry != null);
}

function recordRequestMetrics(
  metrics: Metrics,
  stage: string,
  durationMs: number,
  responseHeaders?: Headers | null,
) {
  metrics.addTiming(stage, durationMs);
  metrics.recordServerTiming(stage, responseHeaders?.get("server-timing") ?? null);
}

function asRequestError(
  stage: string,
  error: unknown,
  opts?: {
    timeout?: boolean;
    durationMs?: number | null;
    responseHeaders?: Headers | null;
    statusCode?: number | null;
    payloadStatusCode?: number | null;
    networkFailure?: boolean;
    networkCode?: string | null;
  },
) {
  if (error instanceof RequestError) {
    if (opts?.durationMs != null && error.durationMs == null) {
      error.durationMs = opts.durationMs;
    }
    if (opts?.responseHeaders && !error.responseHeaders) {
      error.responseHeaders = opts.responseHeaders;
    }
    if (opts?.statusCode != null && error.statusCode == null) {
      error.statusCode = opts.statusCode;
    }
    if (opts?.payloadStatusCode != null && error.payloadStatusCode == null) {
      error.payloadStatusCode = opts.payloadStatusCode;
    }
    if (opts?.networkFailure) {
      error.networkFailure = true;
    }
    if (opts?.networkCode && !error.networkCode) {
      error.networkCode = opts.networkCode;
    }
    if (opts?.timeout) {
      error.timeout = true;
    }
    return error;
  }

  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : typeof error === "string" && error.trim()
        ? error.trim()
        : "request failed";
  const detail = getNetworkErrorDetail(error);

  return new RequestError(stage, detail ? `${message} (${detail})` : message, opts?.timeout ?? false, {
    durationMs: opts?.durationMs ?? null,
    responseHeaders: opts?.responseHeaders ?? null,
    statusCode: opts?.statusCode ?? null,
    payloadStatusCode: opts?.payloadStatusCode ?? null,
    networkFailure: opts?.networkFailure ?? false,
    networkCode: opts?.networkCode ?? null,
  });
}

async function fetchWithTimeout<T>(params: {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  jar: CookieJar;
  stage: string;
  read: (response: Response) => Promise<T>;
}): Promise<{ value: T; durationMs: number; headers: Headers }> {
  const { url, init, timeoutMs, jar, stage, read } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  const cookie = jar.headerValue();
  if (cookie) headers.set("cookie", cookie);
  const startedAt = performance.now();
  let responseHeaders: Headers | null = null;
  let response: Response;

  const performRequest = async () => {
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      const networkCode = error instanceof Error && error.name === "AbortError" ? "timeout" : getNetworkErrorCode(error);
      if (error instanceof Error && error.name === "AbortError") {
        throw new RequestError(stage, `timed out after ${timeoutMs}ms`, true, {
          durationMs: performance.now() - startedAt,
          responseHeaders,
          networkFailure: true,
          networkCode,
        });
      }
      throw asRequestError(stage, error, {
        durationMs: performance.now() - startedAt,
        responseHeaders,
        networkFailure: true,
        networkCode,
      });
    }

    responseHeaders = response.headers;
    jar.apply(response.headers);

    return {
      value: await read(response),
      durationMs: performance.now() - startedAt,
      headers: response.headers,
    };
  };

  try {
    return requestGate ? await requestGate.run(performRequest) : await performRequest();
  } catch (error) {
    const transportLike = isTransportLikeError(error);
    const networkCode = error instanceof Error && error.name === "AbortError" ? "timeout" : getNetworkErrorCode(error);
    if (error instanceof Error && error.name === "AbortError") {
      throw new RequestError(stage, `timed out after ${timeoutMs}ms`, true, {
        durationMs: performance.now() - startedAt,
        responseHeaders,
        networkFailure: true,
        networkCode,
      });
    }
    throw asRequestError(stage, error, {
      durationMs: performance.now() - startedAt,
      responseHeaders,
      networkFailure: transportLike,
      networkCode: transportLike ? networkCode : null,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson<T>(params: {
  url: string;
  method: "GET" | "POST";
  timeoutMs: number;
  jar: CookieJar;
  body?: unknown;
  headers?: HeadersInit;
  stage: string;
  metrics: Metrics;
}) {
  const { url, method, timeoutMs, jar, body, headers, stage, metrics } = params;
  try {
    const result = await fetchWithTimeout({
      url,
      init: {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(headers ?? {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
      jar,
      stage,
      read: async (response) => {
        if (!response.ok) {
          const text = await response.text().catch(() => `HTTP ${response.status}`);
          throw new RequestError(stage, `HTTP ${response.status}: ${truncate(text, 220)}`, false, {
            statusCode: response.status,
            payloadStatusCode: getPayloadStatusCodeFromText(text),
          });
        }

        return (await response.json()) as T;
      },
    });

    recordRequestMetrics(metrics, stage, result.durationMs, result.headers);

    return {
      body: result.value,
      headers: result.headers,
      durationMs: result.durationMs,
    };
  } catch (error) {
    if (error instanceof RequestError && error.durationMs != null) {
      recordRequestMetrics(metrics, stage, error.durationMs, error.responseHeaders);
    }
    throw error;
  }
}

function getInitialHydrationRef(lane: ArenaMatchupLane): ArenaBuildRef | null {
  if (lane.build) return null;
  const initialVariant = lane.buildLoadHints?.initialVariant ?? "full";
  if (initialVariant === "preview") {
    return lane.previewRef ?? lane.buildRef ?? null;
  }
  return lane.buildRef ?? lane.previewRef ?? null;
}

function getHydratedBuildCacheKey(ref: ArenaBuildRef): string {
  return `${ref.buildId}:${ref.variant}:${ref.checksum ?? "none"}`;
}

function getInitialDeliveryClass(hints: ArenaBuildLoadHints | undefined): string | undefined {
  return hints?.initialDeliveryClass ?? hints?.deliveryClass;
}

function needsDetailUpgrade(lane: ArenaMatchupLane) {
  const hints = lane.buildLoadHints;
  if (!lane.buildRef || !hints) return false;
  if (hints.initialVariant !== "preview") return false;
  if (!lane.build) return true;
  return lane.build.blocks.length < hints.fullBlockCount;
}

async function readBuildStream(
  response: Response,
  stage: string,
): Promise<{ totalBlocks: number | null }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-ndjson") || !response.body) {
    const payload = (await response.json()) as BuildVariantResponse;
    return {
      totalBlocks: payload.voxelBuild?.blocks.length ?? null,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawComplete = false;
  let announcedTotal: number | null = null;
  let receivedBlocks = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as ArenaBuildStreamEvent;
      if (event.type === "error") {
        throw new RequestError(stage, event.message || "stream error");
      }
      if (event.type === "hello") {
        announcedTotal = event.totalBlocks;
        continue;
      }
      if (event.type === "chunk") {
        receivedBlocks += Array.isArray(event.blocks) ? event.blocks.length : 0;
        announcedTotal = event.totalBlocks;
        continue;
      }
      if (event.type === "complete") {
        sawComplete = true;
        announcedTotal = event.totalBlocks;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = JSON.parse(buffer.trim()) as ArenaBuildStreamEvent;
    if (event.type === "error") {
      throw new RequestError(stage, event.message || "stream error");
    }
    if (event.type === "chunk") {
      receivedBlocks += Array.isArray(event.blocks) ? event.blocks.length : 0;
      announcedTotal = event.totalBlocks;
    }
    if (event.type === "complete") {
      sawComplete = true;
      announcedTotal = event.totalBlocks;
    }
  }

  if (!sawComplete && announcedTotal != null && receivedBlocks < announcedTotal) {
    throw new RequestError(stage, "stream ended before complete");
  }

  return {
    totalBlocks: announcedTotal ?? receivedBlocks,
  };
}

async function hydrateFullBuild(params: {
  baseUrl: string;
  ref: ArenaBuildRef;
  deliveryClass?: string;
  timeoutMs: number;
  jar: CookieJar;
  headers?: HeadersInit;
  metrics: Metrics;
}) {
  const { baseUrl, ref, deliveryClass, timeoutMs, jar, headers, metrics } = params;
  const snapshotUrl = `${baseUrl}/api/arena/builds/${encodeURIComponent(ref.buildId)}?variant=${ref.variant}${ref.checksum ? `&checksum=${encodeURIComponent(ref.checksum)}` : ""}`;
  const streamArtifactUrl = `${baseUrl}/api/arena/builds/${encodeURIComponent(ref.buildId)}/stream?variant=${ref.variant}${ref.checksum ? `&checksum=${encodeURIComponent(ref.checksum)}` : ""}`;

  const streamAttempts: Array<{
    url: string;
    stage: string;
    source: string;
  }> = [
    {
      url: streamArtifactUrl,
      stage: "build_stream",
      source: "stream_artifact",
    },
    {
      url: snapshotUrl,
      stage: "build_snapshot",
      source: "snapshot_primary",
    },
  ];
  const attempts =
    deliveryClass === "snapshot" || deliveryClass === "inline"
      ? [
          {
            url: snapshotUrl,
            stage: "build_snapshot",
            source: "snapshot_primary",
          },
          {
            url: streamArtifactUrl,
            stage: "build_stream",
            source: "stream_artifact",
          },
        ]
      : streamAttempts;

  const startedAt = performance.now();
  let lastError: unknown = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const result = await fetchWithTimeout({
        url: attempt.url,
        init: { method: "GET", headers },
        timeoutMs,
        jar,
        stage: attempt.stage,
        read: async (response) => {
          if (!response.ok) {
            const text = await response.text().catch(() => `HTTP ${response.status}`);
            throw new RequestError(
              attempt.stage,
              `HTTP ${response.status}: ${truncate(text, 220)}`,
              false,
              {
                statusCode: response.status,
                payloadStatusCode: getPayloadStatusCodeFromText(text),
              },
            );
          }

          await readBuildStream(response, attempt.stage);
          return null;
        },
      });

      recordRequestMetrics(metrics, attempt.stage, result.durationMs, result.headers);

      metrics.addTiming("build_total", performance.now() - startedAt);
      metrics.increment("full_hydrations");
      metrics.increment(`build_source_${attempt.source}`);
      const streamSource = result.headers.get("x-build-stream-source");
      if (streamSource) {
        metrics.increment(`build_header_source_${streamSource}`);
      }
      const snapshotSource = result.headers.get("x-build-source");
      if (snapshotSource) {
        metrics.increment(`build_header_source_${snapshotSource}`);
      }
      if (index > 0) {
        metrics.increment("build_fallback_successes");
      }
      return;
    } catch (error) {
      if (error instanceof RequestError && error.durationMs != null) {
        recordRequestMetrics(metrics, attempt.stage, error.durationMs, error.responseHeaders);
      }
      lastError = error;
      metrics.increment("build_attempt_failures");
      metrics.increment(`${attempt.stage}_attempt_failures`);
    }
  }

  metrics.recordError(
    lastError instanceof RequestError ? lastError.stage : "build_total",
    lastError,
  );
  throw lastError instanceof Error ? lastError : new RequestError("build_total", "build hydration failed");
}

async function fetchMatchup(
  args: Args,
  jar: CookieJar,
  headers: HeadersInit,
  metrics: Metrics,
): Promise<ArenaMatchup> {
  const maxAttempts = Math.max(1, args.matchupRetries + 1);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const url = new URL("/api/arena/matchup", args.baseUrl);
    url.searchParams.set("payload", args.payload);
    if (args.promptId) {
      url.searchParams.set("promptId", args.promptId);
    }

    try {
      const result = await requestJson<ArenaMatchup>({
        url: url.toString(),
        method: "GET",
        timeoutMs: args.matchupTimeoutMs,
        jar,
        headers,
        stage: "matchup",
        metrics,
      });

      metrics.increment("matchup_requests");
      const cacheStatus = result.headers.get("x-arena-coverage-cache");
      if (cacheStatus) {
        metrics.increment(`matchup_cache_${cacheStatus}`);
      }
      const initialA = result.headers.get("x-build-initial-a");
      if (initialA) {
        metrics.increment(`initial_variant_a_${initialA}`);
      }
      const initialB = result.headers.get("x-build-initial-b");
      if (initialB) {
        metrics.increment(`initial_variant_b_${initialB}`);
      }
      if (result.body.samplingLane) {
        metrics.increment(`lane_${result.body.samplingLane}`);
      }
      if (attempt > 1) {
        metrics.increment("matchup_retry_successes");
      }
      return result.body;
    } catch (error) {
      lastError = error;
      const requestError = error instanceof RequestError ? error : null;
      const message = error instanceof Error ? error.message : String(error ?? "");
      const retryable =
        requestError?.timeout === true ||
        requestError?.networkFailure === true ||
        requestError?.statusCode === 500 ||
        requestError?.statusCode === 503 ||
        requestError?.statusCode === 504 ||
        message.includes("timed out") ||
        message.includes("fetch failed") ||
        message.startsWith("HTTP 500") ||
        message.startsWith("HTTP 503") ||
        message.startsWith("HTTP 504");
      if (attempt >= maxAttempts || !retryable) {
        throw error;
      }
      metrics.increment("matchup_retry_attempts");
      await sleep(Math.min(100, attempt * 50));
    }
  }

  throw lastError instanceof Error ? lastError : new RequestError("matchup", "matchup failed");
}

async function submitVote(
  args: Args,
  jar: CookieJar,
  headers: HeadersInit,
  metrics: Metrics,
  matchupId: string,
  choice: "A" | "B",
) {
  await requestJson<{ ok: true }>({
    url: new URL("/api/arena/vote", args.baseUrl).toString(),
    method: "POST",
    timeoutMs: args.voteTimeoutMs,
    jar,
    headers,
    body: { matchupId, choice },
    stage: "vote",
    metrics,
  });

  metrics.increment("votes_ok");
}

async function runUser(userIndex: number, args: Args, deadlineAt: number, metrics: Metrics) {
  const jar = new CookieJar();
  const headers: Record<string, string> = {};
  if (args.isolateUserIp) {
    headers["x-forwarded-for"] = forwardedIpForUser(userIndex);
  }
  const hydratedBuildOrder: string[] = [];
  const hydratedBuildSet = new Set<string>();
  const rememberHydratedBuild = (key: string) => {
    if (hydratedBuildSet.has(key)) return;
    hydratedBuildSet.add(key);
    hydratedBuildOrder.push(key);
    while (hydratedBuildOrder.length > USER_BUILD_CACHE_LIMIT) {
      const oldest = hydratedBuildOrder.shift();
      if (oldest) hydratedBuildSet.delete(oldest);
    }
  };
  const hydrateBuildOnce = async (lane: ArenaMatchupLane) => {
    const ref = getInitialHydrationRef(lane);
    if (!ref) return;
    const cacheKey = getHydratedBuildCacheKey(ref);
    if (hydratedBuildSet.has(cacheKey)) {
      metrics.increment("build_cache_hits");
      return;
    }
    await hydrateFullBuild({
      baseUrl: args.baseUrl,
      ref,
      deliveryClass: getInitialDeliveryClass(lane.buildLoadHints),
      timeoutMs: args.buildTimeoutMs,
      jar,
      headers,
      metrics,
    });
    rememberHydratedBuild(cacheKey);
  };
  const rampMs = Math.max(0, args.rampMs);
  if (rampMs > 0 && args.users > 1) {
    await sleep(((userIndex - 1) / (args.users - 1)) * rampMs);
  }

  while (Date.now() < deadlineAt) {
    const roundStartedAt = performance.now();
    metrics.increment("rounds_started");

    try {
      const matchup = await fetchMatchup(args, jar, headers, metrics);

      const hydrateResults = await Promise.allSettled(
        (["a", "b"] as const).map((side) => hydrateBuildOnce(matchup[side])),
      );

      const hydrateFailure = hydrateResults.find((result) => result.status === "rejected");
      if (hydrateFailure && hydrateFailure.status === "rejected") {
        throw hydrateFailure.reason;
      }

      if (args.thinkMs > 0) {
        await sleep(args.thinkMs);
      }

      if (args.detailUpgradeRate > 0) {
        const detailCandidates = (["a", "b"] as const).filter((side) =>
          needsDetailUpgrade(matchup[side]),
        );
        if (detailCandidates.length > 0 && Math.random() < args.detailUpgradeRate) {
          const selected =
            detailCandidates[Math.floor(Math.random() * detailCandidates.length)] ?? null;
          const lane = selected ? matchup[selected] : null;
          if (selected && lane?.buildRef) {
            metrics.increment("detail_upgrade_rounds");
            try {
              const cacheKey = getHydratedBuildCacheKey(lane.buildRef);
              if (hydratedBuildSet.has(cacheKey)) {
                metrics.increment("build_cache_hits");
              } else {
                await hydrateFullBuild({
                  baseUrl: args.baseUrl,
                  ref: lane.buildRef,
                  deliveryClass: lane.buildLoadHints?.deliveryClass,
                  timeoutMs: args.buildTimeoutMs,
                  jar,
                  headers,
                  metrics,
                });
                rememberHydratedBuild(cacheKey);
              }
            } catch {
              metrics.increment("detail_upgrade_failures");
            }
          }
        }
      }

      const choice: "A" | "B" = Math.random() < 0.5 ? "A" : "B";
      await submitVote(args, jar, headers, metrics, matchup.id, choice);

      metrics.increment("rounds_completed");
      metrics.addTiming("round_total", performance.now() - roundStartedAt);
    } catch (error) {
      const stage = error instanceof RequestError ? error.stage : "round";
      metrics.increment("round_failures");
      const isPerAttemptBuildError =
        error instanceof RequestError &&
        (error.stage === "build_stream" || error.stage === "build_snapshot");
      if (!isPerAttemptBuildError) {
        metrics.recordError(stage, error);
      }
      await sleep(Math.min(500, Math.max(50, args.thinkMs)));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const metrics = new Metrics();
  const deadlineAt = Date.now() + args.durationSeconds * 1000;
  requestGate = args.maxActiveRequests > 0 ? new RequestGate(args.maxActiveRequests) : null;

  console.log("Running arena load test");
  console.log(`- base url: ${args.baseUrl}`);
  console.log(`- users: ${args.users}`);
  console.log(`- duration: ${args.durationSeconds}s`);
  console.log(`- payload mode: ${args.payload}`);
  console.log(`- ramp: ${args.rampMs}ms`);
  if (args.maxActiveRequests > 0) {
    console.log(`- max active requests: ${args.maxActiveRequests}`);
  }
  console.log(`- detail upgrade rate: ${args.detailUpgradeRate}`);
  if (args.isolateUserIp) {
    console.log("- isolated user ip: enabled");
  }
  if (args.promptId) {
    console.log(`- forced prompt: ${args.promptId}`);
  }
  console.log("");

  const progressTimer = setInterval(() => {
    const snapshot = metrics.snapshot();
    console.log(
      `[progress] elapsed=${Math.round(snapshot.elapsedMs / 1000)}s rounds=${snapshot.roundsCompleted} votes=${snapshot.votes} hydrations=${snapshot.fullHydrations} errors=${snapshot.errors}`,
    );
  }, 5_000);

  try {
    await Promise.all(
      Array.from({ length: args.users }, (_, index) =>
        runUser(index + 1, args, deadlineAt, metrics),
      ),
    );
  } finally {
    clearInterval(progressTimer);
  }

  metrics.printSummary(args);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
