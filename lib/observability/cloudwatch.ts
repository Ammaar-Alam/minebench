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
 * Record a failed generation attempt
 */
export function recordGenerationError(
  event: GenerationErrorEvent,
  writer?: MetricLogWriter,
): void {
  emitEmf(
    [["Environment", "JobType", "Model", "ErrorType"]],
    [{ Name: "GenerationErrors", Unit: "Count" }],
    {
      JobType: event.jobType,
      Model: event.model || "unknown",
      ErrorType: (event.errorType || "unknown_error").slice(0, 100),
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

