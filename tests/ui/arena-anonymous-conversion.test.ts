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

const voteBody = functionBodyText("handleVote");
const skipBody = functionBodyText("handleSkip");
const conversionBody = functionBodyText("recordAnonymousVoteForConversion");
const markConversionSeenBody = functionBodyText("markArenaConversionSeen");
const promptBody = functionBodyText("ArenaAccountPrompt");
const promptTimingEffect = effectBodyTextContaining("arenaConversionQueued");
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
    !conversionBody.includes("window.localStorage.setItem(ANONYMOUS_VOTE_CONVERSION_SEEN_KEY") &&
    markConversionSeenBody.includes("arenaConversionSeenRef.current = true") &&
    markConversionSeenBody.includes(
      "window.localStorage.setItem(ANONYMOUS_VOTE_CONVERSION_SEEN_KEY",
    ),
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
  promptBody.includes("dialog.showModal()") &&
    promptBody.indexOf("dialog.showModal()") < promptBody.indexOf("onShown()") &&
    promptBody.includes("dialog.close()") &&
    promptBody.includes("onCancel") &&
    promptBody.includes("event.target !== dialog") &&
    sourceText.includes("For a limited time") &&
    sourceText.includes("Unlimited Gemini 3.7 Flash generations") &&
    sourceText.includes("Sign in to generate free, save your builds, and keep your votes.") &&
    sourceText.includes("No API key needed.") &&
    sourceText.includes("/sign-in?next=/sandbox%3Fmode%3Dlive") &&
    sourceText.includes("Start free") &&
    sourceText.includes("Not now"),
  "the conversion should use a restrained, dismissible account modal with the full offer",
);
assert.ok(
  conversionBody.includes("setArenaConversionQueued(true)") &&
    !conversionBody.includes("setArenaConversionOpen(true)") &&
    promptTimingEffect.includes('reveal.kind !== "none"') &&
    promptTimingEffect.includes("transitioning") &&
    promptTimingEffect.includes("setArenaConversionQueued(false)") &&
    promptTimingEffect.includes("setArenaConversionOpen(true)") &&
    sourceText.includes("onShown={markArenaConversionSeen}") &&
    sourceText.includes("<ArenaAccountPrompt") &&
    !sourceText.includes("Keep your 8 votes"),
  "the modal should wait until the eighth vote reveal and transition have finished",
);

console.log("arena anonymous conversion contract checks passed");
