/**
 * CloudWatch Embedded Metric Format (EMF) Telemetry
 * Emits structured metric logs to stdout, which the Amazon CloudWatch Agent
 * automatically parses and flushes to AWS CloudWatch Metrics asynchronously with zero network latency.
 */

export type JobType = "worker" | "stream";

export interface GenerationSuccessEvent {
  jobType: JobType;
  model: string;
  durationMs: number;
}

export interface GenerationErrorEvent {
  jobType: JobType;
  model: string;
  errorType: string;
}

const CLOUDWATCH_NAMESPACE = process.env.CLOUDWATCH_NAMESPACE || "MineBench/Production";
const ENVIRONMENT = "production";

export type MetricLogWriter = (line: string) => void;

let defaultWriter: MetricLogWriter = (line: string) => {
  process.stdout.write(line + "\n");
};

export function setMetricLogWriter(writer: MetricLogWriter): void {
  defaultWriter = writer;
}

export function resetMetricLogWriter(): void {
  defaultWriter = (line: string) => {
    process.stdout.write(line + "\n");
  };
}

/**
 * Format and emit an EMF JSON line
 */
export function emitEmf(
  dimensions: string[][],
  metrics: Array<{ Name: string; Unit: string }>,
  properties: Record<string, string | number>,
  writer: MetricLogWriter = defaultWriter,
): void {
  const payload = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: CLOUDWATCH_NAMESPACE,
          Dimensions: dimensions,
          Metrics: metrics,
        },
      ],
    },
    Environment: ENVIRONMENT,
    ...properties,
  };

  try {
    writer(JSON.stringify(payload));
  } catch {
    // Telemetry must never crash runtime requests
  }
}

/**
 * Record a successful generation and its latency
 */
export function recordGenerationSuccess(
  event: GenerationSuccessEvent,
  writer?: MetricLogWriter,
): void {
  emitEmf(
    [["Environment", "JobType", "Model"]],
    [
      { Name: "GenerationsCount", Unit: "Count" },
      { Name: "GenerationDuration", Unit: "Milliseconds" },
    ],
    {
      JobType: event.jobType,
      Model: event.model || "unknown",
      GenerationsCount: 1,
      GenerationDuration: Math.max(0, Math.round(event.durationMs)),
    },
    writer,
  );
}

/**
 * Maps raw error messages to a bounded set of stable classification dimensions
 * to prevent high cardinality / unique dimension series in CloudWatch.
 */
export function normalizeErrorClassification(rawError: string | undefined): string {
  if (!rawError) return "unknown_error";
  const lower = rawError.toLowerCase();

  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("etimedout")) {
    return "timeout";
  }
  if (lower.includes("rate_limit") || lower.includes("too many requests") || lower.includes("429")) {
    return "rate_limit";
  }
  if (
    lower.includes("provider_key_expired") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid_api_key") ||
    lower.includes("invalid key") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return "auth_failed";
  }
  if (
    lower.includes("context_length") ||
    lower.includes("context length") ||
    lower.includes("context_window") ||
    lower.includes("context window") ||
    lower.includes("maximum context") ||
    lower.includes("too long")
  ) {
    return "context_length_exceeded";
  }
  if (lower.includes("content_filter") || lower.includes("moderation") || lower.includes("safety")) {
    return "content_filter";
  }
  if (lower.includes("lease") || lower.includes("lease_lost")) {
    return "lease_lost";
  }
  if (lower.includes("persistence_failed") || lower.includes("storage")) {
    return "persistence_failed";
  }
  if (lower.includes("bookkeeping_failed")) {
    return "bookkeeping_failed";
  }
  if (lower.includes("format") || lower.includes("json") || lower.includes("syntax") || lower.includes("parse")) {
    return "format_invalid";
  }
  if (lower.includes("unavailable") || lower.includes("503") || lower.includes("502") || lower.includes("500")) {
    return "provider_unavailable";
  }
  return "other_error";
}

/**
 * Record a failed generation attempt
 */
export function recordGenerationError(
  event: GenerationErrorEvent,
  writer?: MetricLogWriter,
): void {
  const classification = normalizeErrorClassification(event.errorType);
  emitEmf(
    [["Environment", "JobType", "Model", "ErrorType"]],
    [{ Name: "GenerationErrors", Unit: "Count" }],
    {
      JobType: event.jobType,
      Model: event.model || "unknown",
      ErrorType: classification,
      RawError: (event.errorType || "").slice(0, 1000),
      GenerationErrors: 1,
    },
    writer,
  );
}

/**
 * Record the current number of in-flight active generations (Gauge)
 */
export function recordActiveGenerations(
  count: number,
  jobType: JobType = "worker",
  writer?: MetricLogWriter,
): void {
  emitEmf(
    [["Environment", "JobType"]],
    [{ Name: "ActiveGenerations", Unit: "Count" }],
    {
      JobType: jobType,
      ActiveGenerations: Math.max(0, count),
    },
    writer,
  );
}

/**
 * Record queue health (queued job count and oldest job age)
 */
export interface QueueHeartbeatEvent {
  queuedCount: number;
  oldestAgeSeconds: number;
}

export function recordQueueHeartbeat(
  event: QueueHeartbeatEvent,
  writer?: MetricLogWriter,
): void {
  emitEmf(
    [["Environment", "JobType"]],
    [
      { Name: "QueuedJobsCount", Unit: "Count" },
      { Name: "OldestQueuedJobAgeSeconds", Unit: "Seconds" },
    ],
    {
      JobType: "worker",
      QueuedJobsCount: Math.max(0, event.queuedCount),
      OldestQueuedJobAgeSeconds: Math.max(0, Math.round(event.oldestAgeSeconds)),
    },
    writer,
  );
}

/**
 * Start a periodic heartbeat reporting active in-flight generations
 */
export function startActiveGenerationsHeartbeat(
  getActiveCount: () => number,
  intervalMs = 30_000,
  jobType: JobType = "worker",
  writer?: MetricLogWriter,
): NodeJS.Timeout {
  return setInterval(() => {
    recordActiveGenerations(getActiveCount(), jobType, writer);
  }, intervalMs);
}

