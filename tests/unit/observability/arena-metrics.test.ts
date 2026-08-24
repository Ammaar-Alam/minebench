import assert from "node:assert/strict";
import {
  getArenaBlockCountBucket,
  getArenaLatencyBucket,
  roundMetricMs,
} from "../../../lib/observability/arenaMetrics";
import { createBrowserPerformanceTrace } from "../../../lib/observability/browserPerformance";

async function main() {
  assert.equal(getArenaLatencyBucket(99.99), "under-100ms");
  assert.equal(getArenaLatencyBucket(100), "100-250ms");
  assert.equal(getArenaLatencyBucket(999.99), "500-1000ms");
  assert.equal(getArenaLatencyBucket(10_000), "10s-plus");

  assert.equal(getArenaBlockCountBucket(null), "unknown");
  assert.equal(getArenaBlockCountBucket(0), "empty");
  assert.equal(getArenaBlockCountBucket(7_999), "under-8k");
  assert.equal(getArenaBlockCountBucket(8_000), "8k-50k");
  assert.equal(getArenaBlockCountBucket(299_999), "150k-300k");
  assert.equal(getArenaBlockCountBucket(1_000_000), "1m-plus");

  assert.equal(roundMetricMs(12.345), 12.35);
  assert.equal(roundMetricMs(Number.NaN), null);
  assert.equal(roundMetricMs(-1), null);

  const trace = createBrowserPerformanceTrace("test");
  trace.mark("start");
  trace.mark("end");
  assert.ok((trace.duration("start", "end") ?? -1) >= 0);
  assert.ok((trace.measure("total", "start", "end") ?? -1) >= 0);
  assert.equal(trace.duration("missing", "end"), null);
  assert.equal(
    performance
      .getEntries()
      .some((entry) => entry.name.startsWith("minebench:arena:test:")),
    true,
  );
  trace.clear();
  assert.equal(trace.duration("start", "end"), null);
  assert.equal(
    performance
      .getEntries()
      .some((entry) => entry.name.startsWith("minebench:arena:test:")),
    false,
  );
  trace.clear();

  console.log("arena observability metric checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
