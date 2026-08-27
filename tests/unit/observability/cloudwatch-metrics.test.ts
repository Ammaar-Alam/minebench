import assert from "node:assert/strict";
import {
  recordGenerationSuccess,
  recordGenerationError,
  recordActiveGenerations,
  recordQueueHeartbeat,
  startActiveGenerationsHeartbeat,
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
    ["Environment", "JobType", "Model"],
  ]);
  assert.deepEqual(successParsed._aws.CloudWatchMetrics[0].Metrics, [
    { Name: "GenerationsCount", Unit: "Count" },
    { Name: "GenerationDuration", Unit: "Milliseconds" },
  ]);

  // 2. Test recordGenerationError
  lines.length = 0;
  recordGenerationError(
    {
      jobType: "stream",
      model: "claude-opus-5",
      errorType: "rate_limit_exceeded",
    },
    mockWriter,
  );

  assert.equal(lines.length, 1);
  const errorParsed = JSON.parse(lines[0]);
  assert.equal(errorParsed.Environment, "production");
  assert.equal(errorParsed.JobType, "stream");
  assert.equal(errorParsed.Model, "claude-opus-5");
  assert.equal(errorParsed.ErrorType, "rate_limit_exceeded");
  assert.equal(errorParsed.GenerationErrors, 1);
  assert.deepEqual(errorParsed._aws.CloudWatchMetrics[0].Dimensions, [
    ["Environment", "JobType", "Model", "ErrorType"],
  ]);
  assert.deepEqual(errorParsed._aws.CloudWatchMetrics[0].Metrics, [
    { Name: "GenerationErrors", Unit: "Count" },
  ]);

  // 3. Test recordActiveGenerations (Gauge)
  lines.length = 0;
  recordActiveGenerations(4, "worker", mockWriter);

  assert.equal(lines.length, 1);
  const activeParsed = JSON.parse(lines[0]);
  assert.equal(activeParsed.Environment, "production");
  assert.equal(activeParsed.JobType, "worker");
  assert.equal(activeParsed.ActiveGenerations, 4);
  assert.deepEqual(activeParsed._aws.CloudWatchMetrics[0].Dimensions, [
    ["Environment", "JobType"],
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
  const heartbeat = startActiveGenerationsHeartbeat(() => currentCount, 50, "worker", mockWriter);

  await new Promise((resolve) => setTimeout(resolve, 130));
  clearInterval(heartbeat);

  assert.ok(lines.length >= 2);
  const heartbeatParsed = JSON.parse(lines[0]);
  assert.equal(heartbeatParsed.ActiveGenerations, 2);

  console.log("cloudwatch metrics unit tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
