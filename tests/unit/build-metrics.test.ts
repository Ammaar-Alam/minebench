import assert from "node:assert/strict";
import { formatBuildDuration, formatBuildJsonSize } from "../../lib/buildMetrics";

assert.equal(formatBuildDuration(null), null);
assert.equal(formatBuildDuration(0), null);
assert.equal(formatBuildDuration(850), "1s");
assert.equal(formatBuildDuration(59_400), "59s");
assert.equal(formatBuildDuration(60_000), "1m 0s");
assert.equal(formatBuildDuration(185_000), "3m 5s");

assert.equal(formatBuildJsonSize(null), null);
assert.equal(formatBuildJsonSize(640), "640 B");
assert.equal(formatBuildJsonSize(10 * 1024), "10 KiB");
assert.equal(formatBuildJsonSize(16 * 1024 * 1024), "16 MiB");

console.log("build metric formatting checks passed");
