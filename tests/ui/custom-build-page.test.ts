import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE_PATH = "components/custom-builds/CustomBuildPage.tsx";
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

const previewBody = functionBodyText("loadCustomBuildPreview");
const componentBody = functionBodyText("CustomBuildPreview");

assert.ok(
  previewBody.includes('searchParams.set("redirect", "0")') &&
    previewBody.includes("allowRedirect") &&
    previewBody.includes("loadCustomBuildPreview(previewUrl, signal, { redirect: false })"),
  "private custom build previews should retry through the same-origin artifact route when storage redirects are blocked",
);

assert.ok(
  componentBody.includes("loadCustomBuildPreview(previewUrl, abort.signal)"),
  "private custom build page should use the redirect-aware preview loader",
);

console.log("custom build page preview checks passed");
