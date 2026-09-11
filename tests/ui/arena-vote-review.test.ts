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
const votesRef = { current: [{ id: "retained" }] as unknown[] };
let calls = 0;
let respond: (value: unknown) => void = () => { throw new Error("No request pending"); };
const context: Record<string, unknown> = {
  Set, activeSession, votesRequest, votesRef, selectedSessionId: "session-a",
  loadArenaVotePage: () => { calls += 1; return new Promise(resolve => { respond = resolve; }); },
};
for (const key of ["Votes", "SelectedVoteIds", "SelectedSessionId", "PageVoteIds", "NextCursor", "Notice", "VotesLoading", "VotesError", "LoadedSessionId"]) {
  const field = key[0].toLowerCase() + key.slice(1);
  context[`set${key}`] = (value: unknown) => {
    state[field] = typeof value === "function" ? value(state[field]) : value;
    if (field === "votes") votesRef.current = state[field] as unknown[];
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
  const select = evaluate<(id: string) => void>("selectSession"), load = evaluate<(id: string, cursor?: { id: string; createdAt: string }, append?: boolean) => Promise<void>>("loadVotes");
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
  // "New votes" prepends freshly-arrived votes and preserves cross-page selections.
  const id = (n: number) => String(n).padStart(3, "0");
  const range = (start: number, end: number) => Array.from({ length: start - end + 1 }, (_, i) => ({ id: id(start - i) }));
  // The component runs in a VM sandbox, so its arrays share the VM's Array.prototype, not the
  // host's. Read element-by-element to materialise a host array before deep-comparing ids.
  const idsOf = (arr: Array<{ id: string }>): string[] => {
    const out: string[] = [];
    for (let i = 0; i < arr.length; i += 1) out.push(arr[i].id);
    return out;
  };
  const sessionCreatedAt = "2026-09-05T12:00:00.000Z";
  const loaded = range(350, 51);                                  // 300 votes accumulated over 3 pages
  const loadedIds = loaded.map((vote) => vote.id);
  activeSession.current = "session-a";
  votesRequest.current = 0;
  calls = 0;
  state.votes = loaded;
  votesRef.current = loaded;
  state.selectedVoteIds = new Set(["300", "200", "100"]);         // selections spread across pages 1–3
  state.loadedSessionId = "session-a";
  state.nextCursor = { id: id(51), createdAt: sessionCreatedAt };
  state.votesError = null;

  const loadNew = evaluate<(sessionId: string) => Promise<void>>("loadNewVotes");
  const freshPending = loadNew("session-a");
  assert.equal((state.votes as unknown[]).length, 300, "New votes keeps loaded history until the fresh page arrives");
  assert.equal((state.selectedVoteIds as Set<string>).size, 3, "New votes does not drop selections while loading");
  // Page 1 of the refreshed history (351..252) overlaps the existing newest vote (350), so the
  // single new vote (351) is prepended and the older history and cursor are preserved verbatim.
  respond({ ok: true, data: { votes: range(351, 252), nextCursor: { id: id(252), createdAt: sessionCreatedAt } } });
  await freshPending;
  const freshResultIds = idsOf(state.votes as Array<{ id: string }>);
  assert.equal(freshResultIds.length, 301, "New votes prepends only the new votes, deduped by id");
  assert.equal(freshResultIds[0], id(351), "the newest vote is prepended first");
  assert.deepEqual(freshResultIds.slice(1), loadedIds, "the previously loaded history is preserved untouched");
  assert.deepEqual([...(state.selectedVoteIds as Set<string>)].sort(), ["100", "200", "300"], "New votes preserves every cross-page selection");
  assert.deepEqual(state.nextCursor, { id: id(51), createdAt: sessionCreatedAt }, "an overlapping fresh page keeps the cursor so Load more continues from the oldest loaded vote");
  assert.equal(state.votesError, null);
  assert.equal(state.loadedSessionId, "session-a");

  // A burst of new votes exceeding a page creates a gap between the fresh page and the older
  // history; the cursor must advance to the fresh page's next cursor so Load more can fill it.
  const gapPending = loadNew("session-a");
  respond({ ok: true, data: { votes: range(551, 452), nextCursor: { id: id(452), createdAt: sessionCreatedAt } } });
  await gapPending;
  const gapIds = idsOf(state.votes as Array<{ id: string }>);
  assert.equal(gapIds.length, 401, "New votes prepends the full fresh page when nothing overlaps");
  assert.deepEqual(gapIds.slice(0, 100), range(551, 452).map((vote) => vote.id), "the fresh 100 votes are prepended in order");
  assert.deepEqual(state.nextCursor, { id: id(452), createdAt: sessionCreatedAt }, "a non-overlapping fresh page advances the cursor to the gap");
  assert.deepEqual([...(state.selectedVoteIds as Set<string>)].sort(), ["100", "200", "300"], "selection survives a gap-inducing New votes");

  // A failed New-votes fetch surfaces the error without touching the history or selection.
  const failPending = loadNew("session-a");
  respond({ ok: false, error: "Upstream unavailable" });
  await failPending;
  assert.equal(state.votesError, "Upstream unavailable");
  assert.equal(idsOf(state.votes as Array<{ id: string }>).length, 401, "a failed New votes fetch keeps the loaded history");
  assert.equal((state.selectedVoteIds as Set<string>).size, 3, "a failed New votes fetch keeps the selection");

  // Load more appends only votes not already loaded, so the history never duplicates an id,
  // including after a New-votes refresh moves the cursor between the fresh and older pages.
  activeSession.current = "session-a";
  votesRequest.current = 0;
  state.votes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  votesRef.current = state.votes as unknown[];
  state.nextCursor = { id: "c", createdAt: sessionCreatedAt };
  state.selectedVoteIds = new Set(["sel-1", "sel-2"]);
  const appended = load("session-a", state.nextCursor as { id: string; createdAt: string }, true);
  respond({ ok: true, data: { votes: [{ id: "c" }, { id: "d" }, { id: "e" }], nextCursor: { id: "e", createdAt: sessionCreatedAt } } });
  await appended;
  const appendIds = idsOf(state.votes as Array<{ id: string }>);
  assert.deepEqual(appendIds, ["a", "b", "c", "d", "e"], "Load more dedupes votes that overlap the loaded history");
  assert.deepEqual([...(state.selectedVoteIds as Set<string>)].sort(), ["sel-1", "sel-2"], "Load more preserves the selection");
  assert.deepEqual(state.nextCursor, { id: "e", createdAt: sessionCreatedAt }, "Load more advances the cursor");
  assert.equal(new Set(appendIds).size, appendIds.length, "no vote id appears twice after Load more");

  console.log("vote review selection and request checks passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
