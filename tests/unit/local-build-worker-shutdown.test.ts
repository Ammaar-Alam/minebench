import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Message = { type: string; requestId?: number; shutdown?: boolean; [key: string]: unknown };
type Listener = (event: { data: Message }) => void;

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };
const workerCode = ts.transpileModule(
  readFileSync("components/local/localBuildParse.worker.ts", "utf8"),
  { compilerOptions },
).outputText;
const localLabSource = ts.createSourceFile(
  "LocalLab.tsx",
  readFileSync("components/local/LocalLab.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let workerEffect: ts.Expression | undefined;
function findWorkerEffect(node: ts.Node) {
  if (
    ts.isCallExpression(node) && node.expression.getText(localLabSource) === "useEffect" &&
    node.arguments[0]?.getText(localLabSource).includes("new Worker(")
  ) workerEffect = node.arguments[0];
  ts.forEachChild(node, findWorkerEffect);
}
findWorkerEffect(localLabSource);
assert.ok(workerEffect, "LocalLab should own the parse worker lifecycle");
const effectCode = ts.transpileModule(
  `const effect = ${workerEffect.getText(localLabSource).replace("import.meta.url", '"file:///LocalLab.tsx"')}; effect;`,
  { compilerOptions },
).outputText;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function startWorker(createLocalVoxelWorld: (source: unknown, options: { signal: AbortSignal }) => Promise<unknown>) {
  const messages: Message[] = [];
  let closes = 0;
  const scope = {
    onmessage: async (_event: { data: Message }) => {},
    close: () => { closes += 1; },
  };
  runInNewContext(workerCode, {
    exports: {},
    require: (name: string) => name === "@/lib/voxel/localWorld" ? { createLocalVoxelWorld } : {},
    self: scope,
    postMessage: (message: Message) => messages.push(message),
    AbortController,
    Error,
    performance,
  });
  return {
    messages,
    dispatch: (message: Message) => { void scope.onmessage({ data: message }); },
    get closes() { return closes; },
  };
}

const flushWorker = () => new Promise<void>((resolve) => setImmediate(resolve));
const parse = (requestId: number): Message => ({
  type: "parse", requestId, rawText: "", file: { size: 10 },
  gridSize: 1024, palette: "simple", maxBlocksByGrid: { 1024: 100 },
});

async function main() {
  const cleanups = [deferred(), deferred()];
  const cleaned: number[] = [];
  const signals: AbortSignal[] = [];
  const ownership = { worldId: "completed-world", partKeys: ["completed-world/mesh.mbq1.gz"] };
  const worker = startWorker(async (_source, { signal }) => {
    const index = signals.length;
    signals.push(signal);
    if (index === 2) {
      return {
        ...ownership,
        warnings: [],
        blockCount: 1,
        build: {
          version: "1.0", blocks: [],
          world: { manifest: { exactBlockCount: 1, gridSize: 1024, palette: "simple" } },
        },
      };
    }
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await cleanups[index]!.promise;
    cleaned.push(index);
    signal.throwIfAborted();
  });
  const listeners = new Set<Listener>();
  const posted: Message[] = [];
  const deleted: typeof ownership[] = [];
  const uiChanges: unknown[] = [];
  let terminated = false;
  class Worker {
    addEventListener(_type: string, listener: Listener) { listeners.add(listener); }
    removeEventListener(_type: string, listener: Listener) { listeners.delete(listener); }
    postMessage(message: Message) {
      posted.push(message);
      worker.dispatch(message);
    }
    terminate() { terminated = true; }
  }
  const parseWorkerRef = { current: null as Worker | null };
  const effect = runInNewContext(effectCode, {
    Worker,
    URL,
    parseWorkerRef,
    parseRequestIdRef: { current: 3 },
    streamedBlocksRef: { current: [] },
    gridSizeRef: { current: 1024 },
    paletteRef: { current: "simple" },
    setRendered: (value: unknown) => uiChanges.push(value),
    setGridSize: (value: unknown) => uiChanges.push(value),
    setPalette: (value: unknown) => uiChanges.push(value),
    setStatusNote: (value: unknown) => uiChanges.push(value),
    replaceLocalWorld: (value: unknown) => uiChanges.push(value),
    attachLocalVoxelWorldResolver: (value: unknown) => value,
    deleteLocalVoxelWorldParts: async (partKeys: string[], worldId: string) => { deleted.push({ partKeys, worldId }); },
  }) as () => () => void;
  const unmount = effect();
  assert.ok(parseWorkerRef.current);

  worker.dispatch(parse(1));
  worker.dispatch(parse(2));
  assert.equal(signals[0]!.aborted, true, "replacement should cancel the older parse");
  worker.dispatch({ type: "cancel", requestId: 1 });
  assert.equal(signals[1]!.aborted, false, "stale cancellation should preserve the active parse");
  worker.dispatch({ type: "cancel", requestId: 2 });
  assert.equal(signals[1]!.aborted, true);
  worker.dispatch(parse(3));
  await flushWorker();
  assert.equal(worker.messages.filter((message) => message.type === "complete").length, 1, "ordinary cancellation must allow a new parse");
  assert.deepEqual(cleaned, [], "older imports can still be deleting their stored parts");

  unmount();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.type, "cancel");
  assert.equal(posted[0]!.shutdown, true, "unmount must request cooperative shutdown");
  assert.equal(terminated, false, "unmount must let the worker finish storage cleanup");
  assert.equal(parseWorkerRef.current, null);
  assert.equal(worker.closes, 0, "shutdown must retain older parses after the latest parse has completed");
  worker.dispatch(parse(4));
  assert.equal(signals.length, 3, "shutdown must stop accepting parses");

  cleanups[1]!.resolve();
  await flushWorker();
  assert.deepEqual(cleaned, [1]);
  assert.equal(worker.closes, 0, "the final older cleanup must finish before closing");
  cleanups[0]!.resolve();
  await flushWorker();
  assert.deepEqual(cleaned, [1, 0]);
  assert.equal(worker.closes, 1, "worker must close after all storage cleanup finishes");

  const changesAfterUnmount = uiChanges.length;
  for (const message of worker.messages) {
    for (const listener of listeners) listener({ data: message });
  }
  for (const listener of listeners) {
    listener({ data: { type: "progress", requestId: 3, deltaBlocks: [], receivedBlocks: 0, totalBlocks: null } });
  }
  assert.deepEqual(deleted, [ownership], "a queued completion must release its ownership after unmount");
  assert.equal(uiChanges.length, changesAfterUnmount, "disposed worker messages must not update UI state");

  const idle = startWorker(async () => { throw new Error("Idle worker must not start parsing"); });
  idle.dispatch({ type: "cancel", shutdown: true });
  await flushWorker();
  assert.equal(idle.closes, 1, "idle shutdown should close without a pending parse");
  idle.dispatch(parse(1));
  idle.dispatch({ type: "cancel", shutdown: true });
  await flushWorker();
  assert.equal(idle.closes, 1);
  console.log("local build worker cooperative shutdown checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
