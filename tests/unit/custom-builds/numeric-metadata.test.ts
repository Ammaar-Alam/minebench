import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  customBuildJsonNumber,
  customBuildStorageBigInt,
} from "../../../lib/custom-builds/numericMetadata";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/migrations/20260906120000_widen_custom_build_counts/migration.sql",
  "utf8",
);

for (const field of [
  "blockCount",
  "buildByteSize",
  "buildCompressedByteSize",
  "storedByteSize",
  "byteSize",
  "compressedByteSize",
]) {
  assert.match(schema, new RegExp(`${field}\\s+BigInt`));
  assert.ok(migration.includes(`ALTER COLUMN "${field}" TYPE BIGINT`));
}

assert.equal(customBuildJsonNumber(null, "count"), null);
assert.equal(customBuildJsonNumber(549_755_813_888n, "count"), 549_755_813_888);
assert.equal(customBuildJsonNumber(3_221_225_472n, "bytes"), 3_221_225_472);
assert.equal(JSON.stringify({ blockCount: customBuildJsonNumber(549_755_813_888n, "count") }), "{\"blockCount\":549755813888}");
assert.equal(customBuildStorageBigInt(3_221_225_472), 3_221_225_472n);
assert.throws(() => customBuildJsonNumber(-1n, "count"), /JSON-safe integer range/);
assert.throws(() => customBuildJsonNumber(9_007_199_254_740_992n, "bytes"), /JSON-safe integer range/);

console.log("custom build numeric metadata checks passed");
