import assert from "node:assert/strict";

import { parseGenerationTimeMs } from "../../../lib/arena/importBuildMetrics";

assert.deepEqual(parseGenerationTimeMs(null), { ok: true, value: null });
assert.deepEqual(parseGenerationTimeMs(""), { ok: true, value: null });
assert.deepEqual(parseGenerationTimeMs("1046000"), { ok: true, value: 1_046_000 });
assert.deepEqual(parseGenerationTimeMs("0"), { ok: true, value: 0 });
assert.deepEqual(parseGenerationTimeMs("-1"), {
  ok: false,
  error: "generationTimeMs must be a non-negative integer",
});
assert.deepEqual(parseGenerationTimeMs("1.5"), {
  ok: false,
  error: "generationTimeMs must be a non-negative integer",
});
assert.deepEqual(parseGenerationTimeMs("2147483648"), {
  ok: false,
  error: "generationTimeMs is outside the supported integer range",
});

console.log("import build generation metric checks passed");
