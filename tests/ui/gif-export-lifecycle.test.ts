import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const path = "components/sandbox/SandboxGifExportButton.tsx";
const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functionText = (name: string) => {
  const node = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `${name} should exist`);
  return node.getText(source);
};
const code = ts.transpileModule(
  ["createAbortError", "throwIfAborted", "buildPaletteSampleFrames", "buildPaletteSamples", "buildGifBlob"]
    .map(functionText).join("\n").replace("import.meta.url", '"https://minebench.test/export.js"') + "\nbuildGifBlob;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function exportEffect(exportAbortRef: { current: AbortController | null }) {
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[1]?.getText(source) === "[cancelKey]") {
      callback = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback, "the export cancellation effect should exist");
  return runInNewContext(`(${callback.getText(source)})()`, { exportAbortRef }) as (() => void) | undefined;
}

type Mode = "success" | "start-error" | "start-throw" | "start-wait" | "ack-wait" | "result-wait";
function createHarness(mode: Mode = "success", onCapture?: () => void) {
  const workers: FakeWorker[] = [];
  let captures = 0;
  class FakeWorker {
    terminated = false;
    messages: string[] = [];
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    constructor() { workers.push(this); }
    terminate() { this.terminated = true; }
    postMessage(message: { type: string; frameIndex?: number }) {
      this.messages.push(message.type);
      if (message.type === "start" && mode === "start-throw") throw new Error("Worker start failed");
      queueMicrotask(() => {
        if (this.terminated) return;
        if (message.type === "start") {
          if (mode === "start-error") this.onerror?.();
          else if (mode !== "start-wait") this.onmessage?.({ data: { type: "ready" } });
        } else if (message.type === "frame" && mode !== "ack-wait") {
          this.onmessage?.({ data: { type: "ack", frameIndex: message.frameIndex } });
        } else if (message.type === "finish" && mode !== "result-wait") {
          this.onmessage?.({ data: { type: "result", bytes: new Uint8Array([71, 73, 70]).buffer } });
        }
      });
    }
  }
  const render = runInNewContext(code, {
    Worker: FakeWorker, URL, Blob, DOMException, MAX_IN_FLIGHT_FRAMES: 4, YIELD_EVERY_FRAMES: 24,
    document: { createElement: () => ({ getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(16) }) }) }) },
    getExportRotationBases: () => [0], getPaletteSampleSize: () => ({ width: 2, height: 2 }),
    buildExportLayout: () => ({}), waitForNextPaint: () => new Promise<void>((resolve) => setImmediate(resolve)),
    renderCompositeFrame: () => { captures += 1; onCapture?.(); },
  }) as (...args: unknown[]) => Promise<Blob>;
  return {
    workers,
    get captures() { return captures; },
    run: (signal?: AbortSignal, paletteSampleCount = 0) => render([], "", "single", { width: 2, height: 2 }, {
      frameCount: 8, frameDelayMs: 40, frameDelaysMs: [], paletteSampleCount, socialSafe: false,
    }, undefined, signal),
  };
}

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Export did not settle after cancellation")), 1000);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

async function main() {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const mode of ["start-throw", "start-error"] as const) {
      const harness = createHarness(mode);
      await assert.rejects(withDeadline(harness.run()), /Worker start failed|GIF worker crashed/);
      assert.equal(harness.workers[0].terminated, true, `${mode} must terminate its worker`);
    }

    for (const mode of ["start-wait", "ack-wait", "result-wait"] as const) {
      const controller = new AbortController();
      const harness = createHarness(mode);
      const pending = harness.run(controller.signal);
      const rejected = assert.rejects(withDeadline(pending), { name: "AbortError" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      await rejected;
      assert.equal(harness.workers[0].terminated, true, `${mode} cancellation must terminate its worker`);
    }

    for (const unmount of [false, true]) {
      const controller = new AbortController();
      const exportAbortRef = { current: null as AbortController | null };
      const cleanup = exportEffect(exportAbortRef);
      exportAbortRef.current = controller;
      if (unmount) assert.equal(typeof cleanup, "function", "unmount must abort the active export");
      const harness = createHarness("success", () => {
        if (unmount) cleanup?.();
        else controller.abort();
      });
      await assert.rejects(withDeadline(harness.run(controller.signal, 6)), { name: "AbortError" });
      assert.equal(harness.captures, 1, "cancellation must stop palette captures");
      assert.equal(harness.workers[0].terminated, true, "palette cancellation must terminate its worker");
      assert.deepEqual(harness.workers[0].messages, ["start"]);
    }

    const captureFailure = createHarness("success", () => { throw new Error("Capture failed"); });
    await assert.rejects(withDeadline(captureFailure.run(undefined, 6)), /Capture failed/);
    assert.equal(captureFailure.workers[0].terminated, true);

    const workerFailure = createHarness("success", () => queueMicrotask(() => workerFailure.workers[0].onerror?.()));
    await assert.rejects(withDeadline(workerFailure.run(undefined, 6)), /GIF worker crashed/);
    assert.equal(workerFailure.workers[0].terminated, true);
    assert.deepEqual(workerFailure.workers[0].messages, ["start"], "palette worker failure must stop encoding");

    const success = createHarness();
    const blob = await withDeadline(success.run(undefined, 2));
    assert.equal(blob.type, "image/gif");
    assert.equal(blob.size, 3);
    assert.equal(success.captures, 10);
    assert.equal(success.workers[0].messages[1], "palette");
    assert.equal(success.workers[0].terminated, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "worker failures must not leave unhandled promise rejections");
    console.log("GIF export lifecycle checks passed");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
