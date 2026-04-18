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
  deliveryClass: string;
  fullBlockCount: number;
  previewBlockCount: number;
};

type VoxelBuild = {
  version: string;
  blocks: unknown[];
};

type ArenaMatchupLane = {
  build: VoxelBuild | null;
  buildRef?: ArenaBuildRef;
  buildLoadHints?: ArenaBuildLoadHints;
};

type ArenaMatchup = {
  id: string;
  samplingLane?: string;
  a: ArenaMatchupLane;
  b: ArenaMatchupLane;
};

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
  thinkMs: number;
  matchupTimeoutMs: number;
  voteTimeoutMs: number;
  buildTimeoutMs: number;
  help: boolean;
};

class RequestError extends Error {
  stage: string;
  timeout: boolean;

  constructor(stage: string, message: string, timeout = false) {
    super(message);
    this.name = "RequestError";
    this.stage = stage;
    this.timeout = timeout;
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

function parseNumberArg(args: string[], name: string, fallback: number) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const raw = args[index + 1] ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStringArg(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const raw = args[index + 1]?.trim();
  return raw ? raw : undefined;
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
    thinkMs: parseNumberArg(args, "--think-ms", 150),
    matchupTimeoutMs: parseNumberArg(args, "--matchup-timeout-ms", 12_000),
    voteTimeoutMs: parseNumberArg(args, "--vote-timeout-ms", 12_000),
    buildTimeoutMs: parseNumberArg(args, "--build-timeout-ms", 35_000),
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
  --think-ms              Wait time after both builds finish before voting
  --matchup-timeout-ms    Timeout per matchup request
  --vote-timeout-ms       Timeout per vote request
  --build-timeout-ms      Timeout per full-build hydration
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  jar: CookieJar,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  const cookie = jar.headerValue();
  if (cookie) headers.set("cookie", cookie);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
    jar.apply(response.headers);
    return {
      response,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new RequestError("network", `timed out after ${timeoutMs}ms`, true);
    }
    throw error;
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
  let response: Response;
  let durationMs: number;
  try {
    const result = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(headers ?? {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
      jar,
    );
    response = result.response;
    durationMs = result.durationMs;
  } catch (error) {
    if (error instanceof RequestError && error.timeout) {
      throw new RequestError(stage, error.message, true);
    }
    throw error;
  }

  metrics.addTiming(stage, durationMs);
  metrics.recordServerTiming(stage, response.headers.get("server-timing"));

  if (!response.ok) {
    const text = await response.text().catch(() => `HTTP ${response.status}`);
    throw new RequestError(stage, `HTTP ${response.status}: ${truncate(text, 220)}`);
  }

  return {
    body: (await response.json()) as T,
    headers: response.headers,
    durationMs,
  };
}

function needsFullHydration(lane: ArenaMatchupLane) {
  const hints = lane.buildLoadHints;
  if (!lane.buildRef) return false;
  if (!lane.build) return true;
  if (!hints) return false;
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
  const streamLiveUrl = `${baseUrl}/api/arena/builds/${encodeURIComponent(ref.buildId)}/stream?variant=${ref.variant}&artifact=0${ref.checksum ? `&checksum=${encodeURIComponent(ref.checksum)}` : ""}`;

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
    {
      url: streamLiveUrl,
      stage: "build_stream",
      source: "stream_live",
    },
    {
      url: snapshotUrl,
      stage: "build_snapshot",
      source: "snapshot_fallback",
    },
  ];
  const attempts =
    deliveryClass === "snapshot"
      ? [
          {
            url: snapshotUrl,
            stage: "build_snapshot",
            source: "snapshot_primary",
          },
        ]
      : streamAttempts;

  const startedAt = performance.now();
  let lastError: unknown = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      let response: Response;
      let durationMs: number;
      try {
        const result = await fetchWithTimeout(
          attempt.url,
          { method: "GET", headers },
          timeoutMs,
          jar,
        );
        response = result.response;
        durationMs = result.durationMs;
      } catch (error) {
        if (error instanceof RequestError && error.timeout) {
          throw new RequestError(attempt.stage, error.message, true);
        }
        throw error;
      }

      metrics.addTiming(attempt.stage, durationMs);
      metrics.recordServerTiming(attempt.stage, response.headers.get("server-timing"));

      if (!response.ok) {
        const text = await response.text().catch(() => `HTTP ${response.status}`);
        throw new RequestError(attempt.stage, `HTTP ${response.status}: ${truncate(text, 220)}`);
      }

      await readBuildStream(response, attempt.stage);

      metrics.addTiming("build_total", performance.now() - startedAt);
      metrics.increment("full_hydrations");
      metrics.increment(`build_source_${attempt.source}`);
      const streamSource = response.headers.get("x-build-stream-source");
      if (streamSource) {
        metrics.increment(`build_header_source_${streamSource}`);
      }
      if (index > 0) {
        metrics.increment("build_fallback_successes");
      }
      return;
    } catch (error) {
      lastError = error;
      metrics.recordError(attempt.stage, error);
    }
  }

  throw lastError instanceof Error ? lastError : new RequestError("build_total", "build hydration failed");
}

async function fetchMatchup(
  args: Args,
  jar: CookieJar,
  headers: HeadersInit,
  metrics: Metrics,
): Promise<ArenaMatchup> {
  const url = new URL("/api/arena/matchup", args.baseUrl);
  url.searchParams.set("payload", args.payload);
  if (args.promptId) {
    url.searchParams.set("promptId", args.promptId);
  }

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

  return result.body;
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
  const headers = {
    "x-forwarded-for": forwardedIpForUser(userIndex),
  };
  await sleep(Math.min(500, userIndex * 35));

  while (Date.now() < deadlineAt) {
    const roundStartedAt = performance.now();
    metrics.increment("rounds_started");

    try {
      const matchup = await fetchMatchup(args, jar, headers, metrics);

      const hydrateResults = await Promise.allSettled([
        needsFullHydration(matchup.a)
          ? hydrateFullBuild({
              baseUrl: args.baseUrl,
              ref: matchup.a.buildRef as ArenaBuildRef,
              deliveryClass: matchup.a.buildLoadHints?.deliveryClass,
              timeoutMs: args.buildTimeoutMs,
              jar,
              headers,
              metrics,
            })
          : Promise.resolve(),
        needsFullHydration(matchup.b)
          ? hydrateFullBuild({
              baseUrl: args.baseUrl,
              ref: matchup.b.buildRef as ArenaBuildRef,
              deliveryClass: matchup.b.buildLoadHints?.deliveryClass,
              timeoutMs: args.buildTimeoutMs,
              jar,
              headers,
              metrics,
            })
          : Promise.resolve(),
      ]);

      const hydrateFailure = hydrateResults.find((result) => result.status === "rejected");
      if (hydrateFailure && hydrateFailure.status === "rejected") {
        throw hydrateFailure.reason;
      }

      if (args.thinkMs > 0) {
        await sleep(args.thinkMs);
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

  console.log("Running arena load test");
  console.log(`- base url: ${args.baseUrl}`);
  console.log(`- users: ${args.users}`);
  console.log(`- duration: ${args.durationSeconds}s`);
  console.log(`- payload mode: ${args.payload}`);
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
