import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("ArenaVoteReview.tsx", readFileSync("components/arena/ArenaVoteReview.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const state: Record<string, unknown> = {
  votes: [{ id: "retained" }], selectedVoteIds: new Set(["retained"]), loadedSessionId: "session-a",
};
const activeSession = { current: "session-a" as string | null };
const votesRequest = { current: 0 };
let calls = 0;
let respond: (value: unknown) => void = () => { throw new Error("No request pending"); };
const context: Record<string, unknown> = {
  Set, activeSession, votesRequest, selectedSessionId: "session-a",
  loadArenaVotePage: () => { calls += 1; return new Promise(resolve => { respond = resolve; }); },
};
for (const key of ["Votes", "SelectedVoteIds", "SelectedSessionId", "PageVoteIds", "NextCursor", "Notice", "VotesLoading", "VotesError", "LoadedSessionId"]) {
  const field = key[0].toLowerCase() + key.slice(1);
  context[`set${key}`] = (value: unknown) => {
    state[field] = typeof value === "function" ? value(state[field]) : value;
  };
}

function evaluate<T>(name: string): T {
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      expression = (ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer).getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert(expression, `${name} exists`);
  return runInNewContext(ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}

async function main() {
  const select = evaluate<(id: string) => void>("selectSession"), load = evaluate<(id: string) => Promise<void>>("loadVotes");
  select("session-a");
  assert.equal((state.votes as unknown[]).length, 1, "reselecting the current session must keep its history");
  assert.equal(votesRequest.current, 0, "reselecting must not invalidate an in-flight request");

  const failed = load("session-a");
  assert.equal((state.votes as unknown[]).length, 1, "a refresh keeps loaded history until it succeeds");
  respond({ ok: false, error: "Temporary failure" });
  await failed;
  assert.equal((state.votes as unknown[]).length, 1);
  assert.equal(state.votesError, "Temporary failure");

  const stale = load("session-a");
  const resolveStale = respond;
  select("session-b");
  const current = load("session-b");
  resolveStale({ ok: true, data: { votes: [{ id: "wrong-session" }], nextCursor: null } });
  await stale;
  assert.equal((state.votes as unknown[]).length, 0, "stale responses cannot populate the new session");
  respond({ ok: true, data: { votes: [{ id: "current" }], nextCursor: null } });
  await current;
  assert.equal((state.votes as Array<{ id: string }>)[0].id, "current");
  assert.equal(state.loadedSessionId, "session-b");
  assert.equal(state.votesError, null);
  const callsBefore = calls;
  await load("session-a");
  assert.equal(calls, callsBefore, "a stale refresh must not start another request");
  const createdAt = "2026-09-05T12:00:00.000Z";
  Object.assign(context, { loadedSessionId: "session-a", votes: [{ id: "b", createdAt }] });
  for (const [lastVoteId, expected] of [["c", true], ["b", false], ["a", false]] as const) {
    context.selectedSession = { lastVoteId, lastVoteAt: createdAt };
    assert.equal(evaluate("hasNewVotes"), expected, "equal timestamps must use the vote ID tie-breaker");
  }
  console.log("vote review selection and request checks passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
