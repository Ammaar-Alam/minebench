import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/custom-build.ts", "utf8");

const generateStart = source.indexOf("async function generateBuild");
const generationCall = source.indexOf("generateVoxelBuild({", generateStart);
const validationCall = source.indexOf("validateBuildForOutput(args, result.build, \"generated MineBench build\")", generationCall);
const returnExpanded = source.indexOf("build: validated.build", validationCall);
const exportStart = source.indexOf("for (const format of args.exports)");
const exportCall = source.indexOf("exportVoxelBuild(generated.build, palette, format)", exportStart);

assert.ok(
  generateStart >= 0 &&
    generationCall > generateStart &&
    validationCall > generationCall &&
    returnExpanded > validationCall,
  "generated CLI builds should be validated and expanded before being returned",
);
assert.ok(
  exportStart >= 0 && exportCall > exportStart && exportCall > returnExpanded,
  "CLI exports should consume the normalized generated build",
);

console.log("custom build CLI normalization checks passed");
