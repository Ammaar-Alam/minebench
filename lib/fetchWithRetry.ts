import { recordApiFailure, recordApiSuccess } from "@/lib/apiHealth";

/**
 * categorized fetch failures — lets the UI show a useful message
 * instead of "Failed to fetch" or the raw server error text
 */
export type FetchErrorKind =
  | "offline"          // navigator.onLine === false at call time
  | "timeout"          // AbortSignal fired from our own timeout
  | "network"          // fetch threw (DNS, TLS, connection refused, etc)
  | "server"           // 5xx — retryable
  | "rate_limit"       // 429 — retryable w/ backoff
  | "client"           // 4xx (not 408/429) — not retryable
  | "parse";           // body couldn't be parsed as expected

export class FetchError extends Error {
  readonly kind: FetchErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(kind: FetchErrorKind, message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

export type FetchWithRetryOptions = RequestInit & {
  /** per-attempt timeout. default 12s */
  timeoutMs?: number;
  /** number of retry attempts after the first. default 2 (so 3 total). pass 0 for fail-fast on heavy endpoints. */
  retries?: number;
  /** base backoff in ms (doubled each attempt, + jitter). default 400 */
  backoffMs?: number;
  /** max backoff cap. default 4s */
  maxBackoffMs?: number;
  /** caller signal — we compose with our internal timeout */
  parentSignal?: AbortSignal;
  /** fires once per attempt if the request hasn't resolved by this threshold. lets the UI nudge "taking longer than usual". */
  slowThresholdMs?: number;
  /** called when slowThresholdMs fires. safe to call setState. */
  onSlow?: () => void;
};

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 400;
const DEFAULT_MAX_BACKOFF_MS = 4_000;

/** retry only if the category is retryable AND we haven't hit the cap */
function backoffFor(attempt: number, base: number, cap: number): number {
  const raw = base * 2 ** attempt;
  const jitter = Math.random() * base;
  return Math.min(cap, raw + jitter);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeComposedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
    didTimeout: () => timedOut,
  };
}

async function readErrorText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return res.statusText || `HTTP ${res.status}`;
    // try to extract { error: "..." }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        const errorField = (parsed as { error: unknown }).error;
        if (typeof errorField === "string") return errorField;
      }
    } catch {
      /* not json, fall through */
    }
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

function classifyHttp(status: number, message: string): FetchError {
  if (status === 429) return new FetchError("rate_limit", message, status, true);
  if (status >= 500) return new FetchError("server", message, status, true);
  if (status === 408) return new FetchError("timeout", message, status, true);
  return new FetchError("client", message, status, false);
}

function endpointKey(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // strip query string + origin so retries of the same endpoint coalesce for health tracking
    const withoutQuery = raw.split("?")[0] ?? raw;
    if (withoutQuery.startsWith("http")) {
      try {
        return new URL(withoutQuery).pathname;
      } catch {
        return withoutQuery;
      }
    }
    return withoutQuery;
  } catch {
    return "unknown";
  }
}

export async function fetchWithRetry(input: RequestInfo | URL, options: FetchWithRetryOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    parentSignal,
    slowThresholdMs,
    onSlow,
    ...init
  } = options;

  const endpoint = endpointKey(input);
  const maxAttempts = Math.max(1, retries + 1);
  let lastError: FetchError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      lastError = new FetchError("offline", "You appear to be offline.", null, true);
    } else {
      const composed = makeComposedSignal(parentSignal, timeoutMs);
      let slowTimer: ReturnType<typeof setTimeout> | null = null;
      if (onSlow && typeof slowThresholdMs === "number" && slowThresholdMs > 0 && slowThresholdMs < timeoutMs) {
        slowTimer = setTimeout(() => {
          try {
            onSlow();
          } catch {
            /* swallow — we never want a UI callback to break a fetch */
          }
        }, slowThresholdMs);
      }
      try {
        const res = await fetch(input, { ...init, signal: composed.signal });
        if (slowTimer) clearTimeout(slowTimer);
        if (res.ok) {
          composed.cleanup();
          recordApiSuccess(endpoint);
          return res;
        }
        const message = await readErrorText(res);
        composed.cleanup();
        lastError = classifyHttp(res.status, message);
      } catch (err) {
        if (slowTimer) clearTimeout(slowTimer);
        composed.cleanup();
        if (parentSignal?.aborted) throw err;
        if (composed.didTimeout()) {
          lastError = new FetchError("timeout", "Request timed out.", null, true);
        } else if (err instanceof Error && err.name === "AbortError") {
          throw err;
        } else {
          const message = err instanceof Error ? err.message : "Network error";
          lastError = new FetchError("network", message, null, true);
        }
      }
    }

    const isLast = attempt === maxAttempts - 1;
    if (!lastError.retryable || isLast) break;

    try {
      await sleep(backoffFor(attempt, backoffMs, maxBackoffMs), parentSignal);
    } catch (err) {
      // If the parent signal cancelled us during backoff (component unmount,
      // route change), propagate the AbortError instead of masking it as a
      // network/server failure — callers differentiate abort to avoid
      // surfacing spurious errors on cancelled requests.
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw lastError;
    }
  }

  // only record a session-level failure for server-sourced transient kinds —
  // 400/404 client errors aren't "site is degraded" signals, and neither is
  // "offline" (that's a local connectivity problem; flipping session health
  // on it would surface a false "MineBench is having trouble" banner after
  // the user reconnects, even if the backend was fine the whole time).
  if (lastError && lastError.retryable && lastError.kind !== "offline") {
    recordApiFailure(endpoint);
  }
  throw lastError ?? new FetchError("network", "Request failed.", null, false);
}

/** human-friendly message for inline error UIs */
export function describeFetchError(err: unknown): { title: string; hint: string } {
  if (err instanceof FetchError) {
    switch (err.kind) {
      case "offline":
        return { title: "You're offline", hint: "Check your connection and try again." };
      case "timeout":
        return { title: "Request timed out", hint: "The site may be under heavy load. Try again in a moment." };
      case "rate_limit":
        return { title: "Slow down", hint: "Too many requests — wait a few seconds and retry." };
      case "server":
        return { title: "The server is having trouble", hint: "We're on it. Try again in a moment." };
      case "network":
        return { title: "Couldn't reach the server", hint: "Check your connection and try again." };
      case "client":
        return { title: "Request rejected", hint: err.message || "Something about the request was invalid." };
      case "parse":
        return { title: "Unexpected response", hint: "We got a response we didn't understand. Try again." };
    }
  }
  const message = err instanceof Error ? err.message : "Something went wrong.";
  return { title: "Something went wrong", hint: message };
}
