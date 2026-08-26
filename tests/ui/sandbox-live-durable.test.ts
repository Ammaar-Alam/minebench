import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE_PATH = "components/sandbox/SandboxLive.tsx";
const sourceText = readFileSync(SOURCE_PATH, "utf8");
const sourceFile = ts.createSourceFile(SOURCE_PATH, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

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

function effectBodyTextContaining(marker: string): string {
  let body = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === "useEffect" &&
      node.arguments.length > 0
    ) {
      const callback = node.arguments[0];
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.body.getText(sourceFile).includes(marker)
      ) {
        body = callback.body.getText(sourceFile);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!body) throw new Error(`useEffect containing ${marker} should be declared`);
  return body;
}

const durableBody = functionBodyText("runGenerateDurable");
const requestModelBody = functionBodyText("customBuildRequestModel");
const runBody = functionBodyText("runGenerate");
const stopBody = functionBodyText("stopGenerate");
const watchBody = functionBodyText("watchCustomBuild");
const previewBody = functionBodyText("readCustomBuildPreview");
const inputResetEffect = effectBodyTextContaining("lastGenerateInputRef.current === inputSignature");
const assignIndex = durableBody.indexOf("customBuildAbortRef.current = args.abortController");
assert.ok(assignIndex >= 0, "durable generation should store the active abort controller");
assert.equal(
  durableBody.includes("customBuildAbortRef.current?.abort()"),
  false,
  "starting a new run should not abort a stopped create before its returned jobs can be canceled",
);

const applyStatusBody = functionBodyText("applyCustomBuildStatus");
assert.ok(
  applyStatusBody.includes("existing?.customBuildId && existing.customBuildId !== args.status.id"),
  "durable status updates should ignore stale watcher payloads for an older custom build id",
);
assert.ok(
  sourceText.includes("function customBuildStatusPath(id: string): string") &&
    durableBody.includes("const statusUrl = customBuildStatusPath(generation.id)") &&
    durableBody.includes('pageUrl: "/gallery/yours"'),
  "saved generation watchers should use owner-only application routes",
);
assert.ok(
  sourceText.includes("renderGridSize?: GridSize") &&
    sourceText.includes("renderPalette?: Palette") &&
    applyStatusBody.includes("renderGridSize: statusGridSize") &&
    applyStatusBody.includes("renderPalette: statusPalette") &&
    durableBody.includes("renderGridSize: gridSize") &&
    durableBody.includes("renderPalette: palette") &&
    sourceText.includes("gridSize={cardGridSize}") &&
    sourceText.includes("palette={cardPalette}"),
  "durable cards should render with the grid size and palette captured for that custom build",
);

assert.ok(
  durableBody.includes('fetch("/api/generations"') &&
    durableBody.includes("models: selectedModels.map(customBuildRequestModel)") &&
    durableBody.includes("created.generations.length !== selectedModels.length") &&
    durableBody.includes("await Promise.all(") &&
    durableBody.includes("selectedModels.map((model, index)"),
  "one signed-in request should create and watch one saved generation per selected model",
);
assert.ok(
  requestModelBody.includes("id: model.id"),
  "saved-generation requests should include the selected model identity required by the API",
);
assert.ok(
  stopBody.includes("if (signedIn)") &&
    stopBody.includes("canceledDurableRunsRef.current.add(runId)") &&
    stopBody.includes('fetch(`/api/generations/${encodeURIComponent(id)}/cancel`') &&
    stopBody.includes('error: "Generation stopped"'),
  "stopping a signed-in run should cancel every active server-owned job",
);
assert.ok(
  durableBody.includes("if (canceledDurableRunsRef.current.has(args.runId))") &&
    durableBody.includes("created.generations.map((generation)") &&
    durableBody.indexOf("if (canceledDurableRunsRef.current.has(args.runId))") < durableBody.indexOf("setResults((prev)"),
  "a stop racing with job creation should cancel returned jobs before watchers begin",
);
assert.ok(
  sourceText.includes("activeDurableRunRef") &&
    sourceText.includes("durableRunSequenceRef") &&
    runBody.includes("runId: durableRunId!") &&
    !sourceText.includes("durableCancelRequestedRef"),
  "durable cancellation should be scoped to one run so Stop then Generate cannot orphan the first response",
);
assert.ok(
  watchBody.includes("try {") &&
    watchBody.includes("readCustomBuildPreview") &&
    watchBody.includes("catch") &&
    watchBody.includes("console.warn(\"Custom build preview unavailable\""),
  "durable watch should treat preview loading as optional after generation succeeds",
);
const durableInputGuardIndex = inputResetEffect.indexOf("if (signedIn)");
const inputResetAbortIndex = inputResetEffect.indexOf("customBuildAbortRef.current?.abort()");
assert.ok(durableInputGuardIndex >= 0, "durable input edits should have an explicit preservation guard");
assert.ok(inputResetAbortIndex >= 0, "legacy input edits should still abort active generation");
assert.ok(
  durableInputGuardIndex < inputResetAbortIndex &&
    inputResetEffect.slice(durableInputGuardIndex, inputResetAbortIndex).includes("return;"),
  "durable input edits should preserve private links and watchers until another generation starts",
);
assert.ok(
  previewBody.includes("status.previewUrl") &&
    previewBody.includes("readBuildVariantPayload") &&
    previewBody.includes('variant: "preview"'),
  "saved-generation previews should use the shared binary decoder",
);
assert.ok(
  runBody.includes("if (!signedIn && !continueTransient)") &&
    runBody.includes("setShowGenerationPreflight(true)") &&
    runBody.includes("if (signedIn)") &&
    runBody.includes("await runGenerateDurable") &&
    runBody.includes('fetch("/api/generate"'),
  "every signed-out attempt should stop at preflight while signed-in attempts use durable generation",
);
assert.ok(
  sourceText.includes("<GenerationPreflightDialog") &&
    sourceText.includes("void runGenerate(true)") &&
    sourceText.includes("Saved in Yours") &&
    !sourceText.includes("DURABLE_CUSTOM_BUILDS_ENABLED"),
  "preflight continuation and signed-in saved-state navigation should remain visible without a feature flag",
);

console.log("sandbox saved-generation contract checks passed");
