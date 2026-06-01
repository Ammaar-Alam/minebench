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
const stopBody = functionBodyText("stopGenerate");
const watchBody = functionBodyText("watchCustomBuild");
const previewBody = functionBodyText("readCustomBuildPreview");
const inputResetEffect = effectBodyTextContaining("lastGenerateInputRef.current === inputSignature");
const abortIndex = durableBody.indexOf("customBuildAbortRef.current?.abort()");
const assignIndex = durableBody.indexOf("customBuildAbortRef.current = args.abortController");
assert.ok(assignIndex >= 0, "durable generation should store the active abort controller");
assert.ok(abortIndex >= 0, "durable generation should abort the previous watcher before replacing it");
assert.ok(abortIndex < assignIndex, "the previous durable watcher should be aborted before storing the next controller");

const applyStatusBody = functionBodyText("applyCustomBuildStatus");
assert.ok(
  applyStatusBody.includes("existing?.customBuildId && existing.customBuildId !== args.status.id"),
  "durable status updates should ignore stale watcher payloads for an older custom build id",
);

assert.ok(
  sourceText.includes("{DURABLE_CUSTOM_BUILDS_ENABLED ? (") &&
    sourceText.includes("private links for download/export"),
  "private durable-storage copy should only render when durable custom builds are enabled",
);
assert.ok(
  durableBody.includes("watchPromises.push(") &&
    durableBody.includes("await Promise.all(watchPromises)") &&
    !durableBody.includes("void watchCustomBuild"),
  "durable generation should keep running until custom build watchers finish",
);
assert.ok(
  stopBody.includes("DURABLE_CUSTOM_BUILDS_ENABLED") &&
    stopBody.indexOf("return;") < stopBody.indexOf("customBuildAbortRef.current?.abort()"),
  "stopping a durable run should preserve the private link/watch state instead of orphaning the job",
);
assert.ok(
  watchBody.includes("try {") &&
    watchBody.includes("readCustomBuildPreview") &&
    watchBody.includes("catch") &&
    watchBody.includes("console.warn(\"Custom build preview unavailable\""),
  "durable watch should treat preview loading as optional after generation succeeds",
);
const durableInputGuardIndex = inputResetEffect.indexOf("if (DURABLE_CUSTOM_BUILDS_ENABLED)");
const inputResetAbortIndex = inputResetEffect.indexOf("customBuildAbortRef.current?.abort()");
assert.ok(durableInputGuardIndex >= 0, "durable input edits should have an explicit preservation guard");
assert.ok(inputResetAbortIndex >= 0, "legacy input edits should still abort active generation");
assert.ok(
  durableInputGuardIndex < inputResetAbortIndex &&
    inputResetEffect.slice(durableInputGuardIndex, inputResetAbortIndex).includes("return;"),
  "durable input edits should preserve private links and watchers until another generation starts",
);
assert.ok(
  previewBody.includes('searchParams.set("redirect", "0")') &&
    previewBody.includes("allowRedirect") &&
    previewBody.includes("readCustomBuildPreview(status, signal, { redirect: false })"),
  "durable preview downloads should retry through the same-origin artifact route when storage redirects are blocked",
);

console.log("sandbox durable custom build race checks passed");
