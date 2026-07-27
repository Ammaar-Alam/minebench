import assert from "node:assert/strict";
import {
  SANDBOX_COMPARISON_SLOTS,
  getActiveSandboxComparisonSlots,
  normalizeSandboxComparisonSelection,
} from "../../../lib/sandbox/benchmarkComparison";

const available = ["model-a", "model-b", "model-c", "model-d", "model-e"];

const defaults = normalizeSandboxComparisonSelection(available, {});
assert.deepEqual(defaults, {
  a: "model-a",
  b: "model-b",
  c: null,
  d: null,
});
assert.deepEqual(getActiveSandboxComparisonSlots(defaults), ["a", "b"]);

const fourModels = normalizeSandboxComparisonSelection(available, {
  a: "model-d",
  b: "model-a",
  c: "model-e",
  d: "model-c",
});
assert.deepEqual(fourModels, {
  a: "model-d",
  b: "model-a",
  c: "model-e",
  d: "model-c",
});
assert.deepEqual(getActiveSandboxComparisonSlots(fourModels), SANDBOX_COMPARISON_SLOTS);

const invalidModels = normalizeSandboxComparisonSelection(available, {
  a: "missing",
  b: "model-c",
  c: "model-c",
  d: "missing",
});
assert.deepEqual(invalidModels, {
  a: "model-c",
  b: "model-a",
  c: null,
  d: null,
});

assert.deepEqual(
  normalizeSandboxComparisonSelection(available, {
    a: "model-a",
    b: "model-b",
    c: "missing",
    d: "model-d",
  }),
  {
    a: "model-a",
    b: "model-b",
    c: "model-d",
    d: null,
  },
);

assert.deepEqual(normalizeSandboxComparisonSelection(["model-a"], {}), {
  a: "model-a",
  b: null,
  c: null,
  d: null,
});

console.log("sandbox benchmark comparison checks passed");
