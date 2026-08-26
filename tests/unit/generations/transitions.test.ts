import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const generationService = readFileSync("lib/generations/service.ts", "utf8");
const generateJob = readFileSync("lib/custom-builds/generateJob.ts", "utf8");

assert.ok(
  generationService.includes("const canceled = await tx.customBuild.updateMany") &&
    generationService.includes('status: { in: ["queued", "running"] }') &&
    generationService.includes("if (canceled.count !== 1)"),
  "Stop should win only while the generation is still active",
);
assert.ok(
  generationService.includes("const activeRemoval = await tx.customBuild.updateMany") &&
    generationService.includes("const terminalRemoval = await tx.customBuild.updateMany") &&
    generationService.includes("removedAt: null"),
  "removal should not overwrite a terminal state captured after its pre-read",
);
assert.ok(
  generateJob.includes('where: { id: customBuild.id, removedAt: null, status: "running" }') &&
    generateJob.includes("if (failed.count !== 1) throw new CustomBuildLeaseLostError()") &&
    generateJob.includes("if (requeued.count !== 1) throw new CustomBuildLeaseLostError()"),
  "failure and retry writes should yield to cancellation or removal",
);

console.log("saved-generation transition checks passed");
