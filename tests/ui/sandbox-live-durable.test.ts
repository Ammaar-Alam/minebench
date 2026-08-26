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
const completedBuildBody = functionBodyText("readCustomBuildViewer");
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
    durableBody.includes('pageUrl: `/account#${encodeURIComponent(generation.id)}`') &&
    sourceText.includes("Builds"),
  "saved generation watchers should link to the exact owner-only result",
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
  runBody.includes("selectGenerationProviderKeys") &&
    durableBody.includes("providerKeys: args.providerKeys") &&
    !runBody.includes('setKey("anthropic"'),
  "saved generation requests should send only credentials selected by their model routes",
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
    watchBody.includes("readCustomBuildViewer") &&
    watchBody.includes("catch") &&
    watchBody.includes("console.warn(\"Custom build viewer unavailable\""),
  "durable watch should treat viewer loading as optional after generation succeeds",
);
assert.ok(
  watchBody.includes("consecutiveFailures") &&
    watchBody.includes("CustomBuildStatusReadError") &&
    watchBody.includes("Math.min(10_000") &&
    watchBody.includes("continue;"),
  "durable status polling should survive transient reads with bounded backoff",
);
assert.ok(
  sourceText.includes("class CustomBuildViewerReadError") &&
    completedBuildBody.includes("CustomBuildViewerReadError") &&
    watchBody.includes("viewerFailures") &&
    watchBody.includes("error instanceof CustomBuildViewerReadError && error.retryable") &&
    watchBody.includes("continue;"),
  "durable viewer loading should retry transient network and server failures",
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
  completedBuildBody.includes("status.viewerUrl") &&
    completedBuildBody.includes("readBuildVariantPayload") &&
    completedBuildBody.includes('variant: "full"') &&
    !completedBuildBody.includes("status.previewUrl"),
  "successful saved generations should load the full optimized viewer artifact",
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
    sourceText.includes("customBuildPageUrl") &&
    sourceText.includes("<GenerationGalleryButton") &&
    sourceText.includes('label="Export GIF"') &&
    sourceText.includes("embedded") &&
    !sourceText.includes("View saved builds") &&
    !sourceText.includes('"Generating…"') &&
    !sourceText.includes("DURABLE_CUSTOM_BUILDS_ENABLED"),
  "preflight continuation and renderer-owned saved build actions should remain visible without duplicate page controls",
);
assert.ok(
  sourceText.includes("downloadSavedGenerationJson") &&
    !sourceText.includes("href={r.customBuildDownloadUrl}") &&
    sourceText.includes("submittedPrompt") &&
    sourceText.includes("promptText={r?.submittedPrompt ?? prompt}") &&
    sourceText.includes("exportPrompt={resultPrompt}") &&
    sourceText.includes("skipValidation={isDurableResult}"),
  "durable exports should expand stored JSON and retain the submitted prompt snapshot",
);
assert.ok(
  sourceText.includes('aria-controls="sandbox-api-keys"') &&
    sourceText.includes("xl:col-span-2") &&
    sourceText.includes("mb-disclosure-chevron") &&
    !sourceText.includes(">Connection</span>") &&
    !sourceText.includes(">Manage</span>"),
  "API keys should use a flat full-width disclosure with literal labels and shared motion",
);
assert.ok(
  sourceText.includes('model.key === "gemini_3_7_flash"') &&
    !sourceText.includes('model.key === "openai_gpt_5_6_luna"') &&
    sourceText.includes('useState(() => initialPrompt ?? "")') &&
    !sourceText.includes("a pirate ship with sails"),
  "Generate should start blank with Gemini 3.7 Flash selected",
);

console.log("sandbox saved-generation contract checks passed");
