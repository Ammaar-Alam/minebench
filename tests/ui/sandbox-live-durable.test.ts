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

const durableBody = functionBodyText("runGenerateDurable");
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

console.log("sandbox durable custom build race checks passed");
