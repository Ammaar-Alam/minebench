import assert from "node:assert/strict";

import { extractBestVoxelBuildJson, extractFirstJsonObject } from "../../../lib/ai/jsonExtract";

function voxelBuild(blocks: Array<{ x: number; y: number; z: number; type: string }> = [
  { x: 0, y: 0, z: 0, type: "stone" },
]): string {
  return JSON.stringify({ version: "1.0", boxes: [], lines: [], blocks });
}

// Build a single VoxelBuild object string with arbitrary keys/order preserved.
function objectJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function assertHasBlocks(
  value: unknown,
  expected: number,
  message: string,
): void {
  assert.ok(value && typeof value === "object", `${message}: expected an object`);
  const v = value as { version?: unknown; blocks?: unknown };
  assert.equal(v.version, "1.0", `${message}: version should be 1.0`);
  assert.ok(Array.isArray(v.blocks), `${message}: blocks should be an array`);
  assert.equal(v.blocks.length, expected, `${message}: expected ${expected} block(s)`);
}

// --- Regression: clean inputs that must keep working ------------------------

{
  const clean = voxelBuild();
  const first = extractFirstJsonObject(clean);
  const best = extractBestVoxelBuildJson(clean);
  assertHasBlocks(first, 1, "clean object extractFirst");
  assertHasBlocks(best, 1, "clean object extractBest");
}

{
  const fenced = "```json\n" + voxelBuild() + "\n```";
  assertHasBlocks(extractFirstJsonObject(fenced), 1, "json fence extractFirst");
  assertHasBlocks(extractBestVoxelBuildJson(fenced), 1, "json fence extractBest");
}

{
  const fencedBackticks = "```\n" + voxelBuild() + "\n```";
  assertHasBlocks(extractBestVoxelBuildJson(fencedBackticks), 1, "plain code fence");
}

// --- Regression: balanced quotes in prose (was already passing) ------------

{
  const balancedPreamble = `Here is "the" voxel build as "JSON":\n` + voxelBuild();
  assertHasBlocks(extractFirstJsonObject(balancedPreamble), 1, "balanced prose extractFirst");
  assertHasBlocks(extractBestVoxelBuildJson(balancedPreamble), 1, "balanced prose extractBest");
}

// --- THE BUG: unbalanced (stray) top-level quote before the object ----------

{
  const strayQuote = `Here is the " voxel build as JSON:\n` + voxelBuild();
  assertHasBlocks(extractFirstJsonObject(strayQuote), 1, "stray quote preamble extractFirst");
  assertHasBlocks(extractBestVoxelBuildJson(strayQuote), 1, "stray quote preamble extractBest");
}

{
  const strayQuoteMultiblock = `Here is the " voxel build:\n` + voxelBuild([
    { x: 0, y: 0, z: 0, type: "stone" },
    { x: 1, y: 0, z: 0, type: "stone" },
    { x: 2, y: 0, z: 0, type: "stone" },
  ]);
  assertHasBlocks(extractBestVoxelBuildJson(strayQuoteMultiblock), 3, "stray quote with multiple blocks");
}

// --- THE BUG: wrapping quotes around the object ("Output "JSON": " {...} ") --

{
  const wrapped = `Output "JSON": " ` + voxelBuild() + ` "`;
  assertHasBlocks(extractFirstJsonObject(wrapped), 1, "wrapped quote extractFirst");
  assertHasBlocks(extractBestVoxelBuildJson(wrapped), 1, "wrapped quote extractBest");
}

// --- Stray quote appearing AFTER the object (trailing prose) ---------------

{
  const trailing = voxelBuild() + ` that's the " build`;
  assertHasBlocks(extractFirstJsonObject(trailing), 1, "trailing stray quote extractFirst");
  assertHasBlocks(extractBestVoxelBuildJson(trailing), 1, "trailing stray quote extractBest");
}

// --- Regression: escaped quotes and braces inside JSON string values --------

{
  const escapedQuoteInValue =
    `{"version":"1.0","blocks":[{"x":0,"y":0,"z":0,"type":"he said \\"hi\\" {ignore}"}]}`;
  assertHasBlocks(
    extractFirstJsonObject(escapedQuoteInValue),
    1,
    "escaped quote + brace inside string value extractFirst",
  );
  assertHasBlocks(
    extractBestVoxelBuildJson(escapedQuoteInValue),
    1,
    "escaped quote + brace inside string value extractBest",
  );
}

// --- Regression: escaped backslash immediately before a closing quote --------

{
  const escapedBackslash = `{"version":"1.0","blocks":[{"x":0,"y":0,"z":0,"type":"a\\\\"}]}`;
  assertHasBlocks(extractFirstJsonObject(escapedBackslash), 1, "escaped backslash before quote");
  const value = extractFirstJsonObject(escapedBackslash) as {
    blocks: Array<{ type: string }>;
  };
  assert.equal(value.blocks[0]?.type, "a\\", "escaped backslash value preserved");
}

// --- Regression: `}` inside a string value must not close the object --------

{
  const braceInString = `{"version":"1.0","blocks":[{"x":0,"y":0,"z":0,"type":"a}b"}]}`;
  assertHasBlocks(extractFirstJsonObject(braceInString), 1, "brace inside string value");
  const value = extractFirstJsonObject(braceInString) as {
    blocks: Array<{ type: string }>;
  };
  assert.equal(value.blocks[0]?.type, "a}b", "brace inside string value preserved");
}

// --- Regression: nested objects are extracted as the outer whole object ----

{
  const nested =
    `{"version":"1.0","blocks":[{"x":0,"y":0,"z":0,"type":"stone","meta":{"n":1,"m":{"k":2}}}]}`;
  assertHasBlocks(extractFirstJsonObject(nested), 1, "nested object extractFirst");
  const value = extractFirstJsonObject(nested) as {
    blocks: Array<{ meta?: { n?: number; m?: { k?: number } } }>;
  };
  assert.equal(value.blocks[0]?.meta?.m?.k, 2, "deeply nested value preserved");
}

// --- extractFirstJsonObject returns the first parseable object --------------

{
  const twoObjects = `{"a":1} ` + voxelBuild([{ x: 1, y: 1, z: 1, type: "stone" }]);
  const first = extractFirstJsonObject(twoObjects) as { a?: number };
  assert.deepEqual(first, { a: 1 }, "extractFirst returns the first object");
}

// --- extractFirstJsonObject skips a malformed leading object ----------------

{
  const malformedThenReal = `{"a":}` + voxelBuild([{ x: 1, y: 1, z: 1, type: "stone" }]);
  assertHasBlocks(
    extractFirstJsonObject(malformedThenReal),
    1,
    "extractFirst skips malformed leading object and finds the real one",
  );
}

// --- extractBestVoxelBuildJson prefers the VoxelBuild among multiple objects --

{
  const exampleThenReal =
    `{"example": {"version":"1.0","blocks":[]}} ` +
    voxelBuild([
      { x: 0, y: 0, z: 0, type: "stone" },
      { x: 1, y: 0, z: 0, type: "stone" },
    ]);
  const best = extractBestVoxelBuildJson(exampleThenReal);
  assertHasBlocks(best, 2, "extractBest picks the VoxelBuild with the most blocks");
}

// --- extractBestVoxelBuildJson falls back to extractFirstJsonObject -----------

{
  const nonVoxel = `Preamble " here\n{"answer":42}`;
  const fallback = extractBestVoxelBuildJson(nonVoxel) as { answer?: number };
  assert.deepEqual(fallback, { answer: 42 }, "extractBest falls back to first object when no VoxelBuild");
}

// --- Multiple objects after a stray quote (was failing before the fix) ------

{
  const strayThenTwo =
    `Here " is your build:\n{"a":1} ` + voxelBuild([{ x: 1, y: 1, z: 1, type: "stone" }]);
  assertHasBlocks(
    extractBestVoxelBuildJson(strayThenTwo),
    1,
    "extractBest finds VoxelBuild among multiple objects after stray quote",
  );
  const first = extractFirstJsonObject(strayThenTwo) as { a?: number };
  assert.deepEqual(first, { a: 1 }, "extractFirst returns first object after stray quote");
}

// --- Negative cases: no object present --------------------------------------

{
  assert.equal(extractFirstJsonObject("just prose, no object"), null, "no object -> null");
  assert.equal(extractBestVoxelBuildJson("just prose, no object"), null, "no object -> null (best)");
}

{
  assert.equal(extractFirstJsonObject(""), null, "empty string -> null");
  assert.equal(extractBestVoxelBuildJson(""), null, "empty string -> null (best)");
}

// --- Stray quote alone with no object must not produce a phantom ------------

{
  assert.equal(
    extractFirstJsonObject(`" a stray quote and nothing else`),
    null,
    "stray quote with no object -> null",
  );
}

// --- objectJson helper sanity (ensures objectJson usage is valid JSON) ------

{
  const obj = objectJson({ version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] });
  assert.deepEqual(extractFirstJsonObject(obj), JSON.parse(obj), "objectJson round-trips");
}

console.log("jsonExtract checks passed");
