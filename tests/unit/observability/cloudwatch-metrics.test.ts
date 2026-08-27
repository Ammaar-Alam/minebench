import assert from "node:assert/strict";
import {
  generationErrorMetricData,
  generationSuccessMetricData,
  recordGenerationSuccess,
  recordGenerationError,
  recordActiveGenerations,
  recordQueueHeartbeat,
  startActiveGenerationsHeartbeat,
  normalizeErrorClassification,
} from "../../../lib/observability/cloudwatch";

async function main() {
  const lines: string[] = [];
  const mockWriter = (line: string) => {
    lines.push(line);
  };

  // 1. Test recordGenerationSuccess
  recordGenerationSuccess(
    {
      jobType: "worker",
      model: "gpt-5-2-pro",
      durationMs: 12450.6,
    },
    mockWriter,
  );

  assert.equal(lines.length, 1);
  const successParsed = JSON.parse(lines[0]);
  assert.equal(successParsed.Environment, "production");
  assert.equal(successParsed.JobType, "worker");
  assert.equal(successParsed.Model, "gpt-5-2-pro");
  assert.equal(successParsed.GenerationsCount, 1);
  assert.equal(successParsed.GenerationDuration, 12451);
  assert.equal(successParsed._aws.CloudWatchMetrics[0].Namespace, "MineBench/Production");
  assert.deepEqual(successParsed._aws.CloudWatchMetrics[0].Dimensions, [
    ["Environment"],
    ["Environment", "JobType", "Model"],
  ]);
  assert.deepEqual(successParsed._aws.CloudWatchMetrics[0].Metrics, [
    { Name: "GenerationsCount", Unit: "Count" },
    { Name: "GenerationDuration", Unit: "Milliseconds" },
  ]);
  const successMetricData = generationSuccessMetricData({
    jobType: "stream",
    model: "gpt-test",
    durationMs: 3210,
  });
  assert.equal(successMetricData.length, 4);
  assert.deepEqual(successMetricData[0]?.Dimensions, [{ Name: "Environment", Value: "production" }]);
  assert.deepEqual(successMetricData[2]?.Dimensions, [
    { Name: "Environment", Value: "production" },
    { Name: "JobType", Value: "stream" },
    { Name: "Model", Value: "gpt-test" },
  ]);

  // 2. Test recordGenerationError
  lines.length = 0;
  recordGenerationError(
    {
      jobType: "stream",
      model: "claude-opus-5",
      errorType: "rate_limit_exceeded (request_id: req_12345)",
    },
    mockWriter,
  );

  assert.equal(lines.length, 1);
  const errorParsed = JSON.parse(lines[0]);
  assert.equal(errorParsed.Environment, "production");
  assert.equal(errorParsed.JobType, "stream");
  assert.equal(errorParsed.Model, "claude-opus-5");
  assert.equal(errorParsed.ErrorType, "rate_limit");
  assert.equal(errorParsed.RawError, "rate_limit_exceeded (request_id: req_12345)");
  assert.equal(errorParsed.GenerationErrors, 1);
  assert.deepEqual(errorParsed._aws.CloudWatchMetrics[0].Dimensions, [
    ["Environment"],
    ["Environment", "JobType", "Model", "ErrorType"],
  ]);
  assert.deepEqual(errorParsed._aws.CloudWatchMetrics[0].Metrics, [
    { Name: "GenerationErrors", Unit: "Count" },
  ]);
  const errorMetricData = generationErrorMetricData({
    jobType: "stream",
    model: "gpt-test",
    errorType: "OpenRouter error 402: Insufficient credits",
  });
  assert.equal(errorMetricData.length, 2);
  assert.deepEqual(errorMetricData[1]?.Dimensions, [
    { Name: "Environment", Value: "production" },
    { Name: "JobType", Value: "stream" },
    { Name: "Model", Value: "gpt-test" },
    { Name: "ErrorType", Value: "insufficient_credits" },
  ]);

  // 3. Test recordActiveGenerations (Gauge)
  lines.length = 0;
  recordActiveGenerations(4, "worker", mockWriter);

  assert.equal(lines.length, 1);
  const activeParsed = JSON.parse(lines[0]);
  assert.equal(activeParsed.Environment, "production");
  assert.equal(activeParsed.JobType, "worker");
  assert.equal(activeParsed.ActiveGenerations, 4);
  assert.equal(activeParsed.WorkerAcceptingJobs, 1);
  assert.deepEqual(activeParsed._aws.CloudWatchMetrics[0].Dimensions, [
    ["Environment", "JobType"],
  ]);
  assert.deepEqual(activeParsed._aws.CloudWatchMetrics[0].Metrics, [
    { Name: "ActiveGenerations", Unit: "Count" },
    { Name: "WorkerAcceptingJobs", Unit: "Count" },
  ]);

  // 4. Test recordQueueHeartbeat
  lines.length = 0;
  recordQueueHeartbeat(
    {
      queuedCount: 3,
      oldestAgeSeconds: 125,
    },
    mockWriter,
  );

  assert.equal(lines.length, 1);
  const queueParsed = JSON.parse(lines[0]);
  assert.equal(queueParsed.Environment, "production");
  assert.equal(queueParsed.JobType, "worker");
  assert.equal(queueParsed.QueuedJobsCount, 3);
  assert.equal(queueParsed.OldestQueuedJobAgeSeconds, 125);
  assert.deepEqual(queueParsed._aws.CloudWatchMetrics[0].Metrics, [
    { Name: "QueuedJobsCount", Unit: "Count" },
    { Name: "OldestQueuedJobAgeSeconds", Unit: "Seconds" },
  ]);

  // 5. Test Heartbeat interval
  lines.length = 0;
  let currentCount = 2;
  let acceptingJobs = true;
  const heartbeat = startActiveGenerationsHeartbeat(
    () => currentCount,
    () => acceptingJobs,
    50,
    "worker",
    mockWriter,
  );

  assert.equal(lines.length, 1, "worker heartbeats should emit immediately on startup");
  assert.equal(JSON.parse(lines[0]).WorkerAcceptingJobs, 1);

  acceptingJobs = false;

  await new Promise((resolve) => setTimeout(resolve, 130));
  clearInterval(heartbeat);

  assert.ok(lines.length >= 3);
  const heartbeatParsed = JSON.parse(lines[1]);
  assert.equal(heartbeatParsed.ActiveGenerations, 2);
  assert.equal(heartbeatParsed.WorkerAcceptingJobs, 0);

  // 6. Test normalizeErrorClassification
  assert.equal(normalizeErrorClassification("ETIMEDOUT connection failed"), "timeout");
  assert.equal(normalizeErrorClassification("Rate limit exceeded: 429 Too Many Requests"), "rate_limit");
  assert.equal(normalizeErrorClassification("provider_key_expired: key 12345 expired"), "auth_failed");
  assert.equal(normalizeErrorClassification("Request exceeds context length 128000"), "context_length_exceeded");
  assert.equal(normalizeErrorClassification("Custom build lease lost for job"), "lease_lost");
  assert.equal(normalizeErrorClassification("OpenRouter error 402: Insufficient credits"), "insufficient_credits");
  assert.equal(normalizeErrorClassification(undefined), "unknown_error");

  console.log("cloudwatch metrics unit tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
