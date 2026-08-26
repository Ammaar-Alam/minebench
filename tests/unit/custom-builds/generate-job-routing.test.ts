import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  customBuildModelForGeneration,
  providerKeysForSecret,
} from "../../../lib/custom-builds/generateJob";

const SOURCE_PATH = "lib/custom-builds/generateJob.ts";
const sourceText = readFileSync(SOURCE_PATH, "utf8");
const sourceFile = ts.createSourceFile(SOURCE_PATH, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function functionBodyText(name: string): string {
  let body = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      body = node.body.getText(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!body) throw new Error(`${name} should be declared`);
  return body;
}

const modelBody = functionBodyText("customBuildModelForGeneration");
const generateBody = functionBodyText("generateBuild");

assert.ok(
  modelBody.includes("customBuild.modelProvider") &&
    modelBody.includes("customBuild.modelId") &&
    modelBody.includes("customBuild.modelDisplayName") &&
    modelBody.includes("customBuild.openRouterModelId"),
  "custom generate jobs should build provider routing from persisted CustomBuild fields",
);

assert.ok(
  generateBody.includes("model: customBuildModelForGeneration(customBuild, customBaseUrl)") &&
    !generateBody.includes("modelKey: customBuild.modelKey"),
  "custom generate jobs should not re-resolve queued catalog rows through the mutable model catalog",
);

const openRouterModel = customBuildModelForGeneration({
  modelKind: "openrouter",
  modelKey: null,
  modelProvider: "custom",
  modelId: "vendor/model",
  modelDisplayName: "Vendor model",
  openRouterModelId: "vendor/model",
  publicId: "cb_123456789012345678901234",
} as never);
assert.equal(openRouterModel.provider, "custom");
assert.equal(openRouterModel.forceOpenRouter, true);
assert.equal(openRouterModel.openRouterModelId, "vendor/model");
assert.deepEqual(providerKeysForSecret("openrouter", "router-key"), { openrouter: "router-key" });
assert.deepEqual(providerKeysForSecret("meta", "meta-key"), { meta: "meta-key" });
assert.deepEqual(providerKeysForSecret("zai", "zai-key"), { zai: "zai-key" });

console.log("custom build generate job routing checks passed");
