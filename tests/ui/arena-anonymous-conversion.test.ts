import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE_PATH = "components/arena/Arena.tsx";
const sourceText = readFileSync(SOURCE_PATH, "utf8");
const sourceFile = ts.createSourceFile(
  SOURCE_PATH,
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

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

const voteBody = functionBodyText("handleVote");
const skipBody = functionBodyText("handleSkip");
const conversionBody = functionBodyText("recordAnonymousVoteForConversion");
const submitIndex = voteBody.indexOf("await submitArenaAction");
const conversionIndex = voteBody.indexOf("recordAnonymousVoteForConversion()");

assert.ok(
  sourceText.includes("const ANONYMOUS_VOTE_CONVERSION_THRESHOLD = 8") &&
    sourceText.includes("ANONYMOUS_VOTE_COUNT_KEY") &&
    sourceText.includes("ANONYMOUS_VOTE_CONVERSION_SEEN_KEY"),
  "the anonymous conversion should wait for eight successful votes and persist its progress",
);
assert.ok(
  conversionBody.includes("hasSupabaseAuthCookie(document.cookie)") &&
    conversionBody.includes("window.localStorage.getItem(ANONYMOUS_VOTE_CONVERSION_SEEN_KEY)") &&
    conversionBody.includes("window.localStorage.setItem(ANONYMOUS_VOTE_COUNT_KEY") &&
    conversionBody.includes("window.localStorage.setItem(ANONYMOUS_VOTE_CONVERSION_SEEN_KEY"),
  "the Arena conversion should remain anonymous-only and appear once per browser",
);
assert.ok(
  submitIndex >= 0 &&
    conversionIndex > submitIndex &&
    conversionIndex < voteBody.indexOf("await loadNextMatchup") &&
    !skipBody.includes("recordAnonymousVoteForConversion"),
  "only a durable vote should advance the anonymous conversion counter",
);
assert.ok(
  sourceText.includes("Keep your 8 votes") &&
    sourceText.includes("Generate free with Gemini 3.7 Flash.") &&
    sourceText.includes("/sign-in?next=/sandbox%3Fmode%3Dlive") &&
    sourceText.includes("Not now"),
  "the conversion should connect saved votes to the free Generate flow without blocking Arena",
);

console.log("arena anonymous conversion contract checks passed");
