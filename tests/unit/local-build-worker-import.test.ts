import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as localWorld from "../../lib/voxel/localWorld";
import type { RenderableVoxelBuild } from "../../lib/voxel/packedBlocks";

type WorldOptions = Parameters<typeof localWorld.createLocalVoxelWorldForTest>[1];
type WorldResult = localWorld.LocalVoxelWorldResult;
type Message = { type: string; voxelBuild?: RenderableVoxelBuild; message?: string; [key: string]: unknown };

const require = createRequire(import.meta.url);
const workerCode = ts.transpileModule(readFileSync("components/local/localBuildParse.worker.ts", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const worldOptions = { gridSize: 2048, palette: "simple" as const, worldId: "paste-import-test" };

function startWorker(
  createWorld: (input: unknown, opts: WorldOptions) => Promise<WorldResult> = (input, opts) =>
    localWorld.createLocalVoxelWorldForTest(input, { ...opts, worldId: worldOptions.worldId }),
  fetchResponse?: typeof fetch,
) {
  const messages: Message[] = [];
  const inputs: unknown[] = [];
  const scope = { onmessage: async (_event: { data: Record<string, unknown> }) => {}, close() {} };
  let maxJsonParseChars = 0;
  runInNewContext(workerCode, {
    exports: {}, self: scope, AbortController, Error, performance, Blob,
    fetch: fetchResponse,
    JSON: {
      stringify: JSON.stringify,
      parse(text: string) { maxJsonParseChars = Math.max(maxJsonParseChars, text.length); return JSON.parse(text); },
    },
    require(name: string) {
      return name === "@/lib/voxel/localWorld" ? {
        ...localWorld,
        createLocalVoxelWorld: (input: unknown, opts: WorldOptions) => {
          inputs.push(input);
          return createWorld(input, opts);
        },
      } : require(name);
    },
    postMessage(message: Message) { messages.push(structuredClone(message)); },
  });
  return {
    messages,
    inputs,
    get maxJsonParseChars() { return maxJsonParseChars; },
    parse: (rawText: string) => scope.onmessage({ data: {
      type: "parse", requestId: 1, rawText, gridSize: 2048, palette: "simple", maxBlocksByGrid: { 2048: Number.MAX_SAFE_INTEGER },
    } }),
    cancel: () => scope.onmessage({ data: { type: "cancel", requestId: 1 } }),
  };
}

function completedBuild(messages: Message[]) {
  const build = messages.find((message) => message.type === "complete")?.voxelBuild;
  assert.ok(build?.world, messages.find((message) => message.type === "error")?.message);
  return build;
}

async function main() {
  const source = ` \n${JSON.stringify({ version: "1.0", boxes: [], lines: [], blocks: Array.from({ length: 81_920 }, (_, index) => ({
    x: index % 64, y: Math.floor(index / 64) % 16, z: Math.floor(index / 1024), type: index % 17 === 0 ? "glass" : "stone",
  })) })}\n`;
  assert.ok(source.length > 2_500_000);
  const file = await localWorld.createLocalVoxelWorldForTest(new Blob([source]), worldOptions);
  let pasted: Awaited<ReturnType<typeof localWorld.createLocalVoxelWorldForTest>> | undefined;
  const worker = startWorker(async (input, opts) => {
    pasted = await localWorld.createLocalVoxelWorldForTest(input, { ...opts, worldId: worldOptions.worldId });
    return pasted;
  });
  await worker.parse(source);
  const build = completedBuild(worker.messages);
  assert.equal(worker.inputs.length, 1);
  assert.ok(worker.inputs[0] instanceof Blob);
  assert.equal(worker.maxJsonParseChars, 0, "the worker must not JSON.parse the complete source text");
  assert.deepEqual(Object.keys(build).sort(), ["blocks", "version", "world"]);
  assert.equal(build.blocks.length, 0);
  assert.equal(build.world!.manifest.source.sha256, createHash("sha256").update(source).digest("hex"));
  assert.deepEqual(build.world!.manifest, file.build.world!.manifest);
  assert.equal(build.world!.manifest.exactBlockCount, 81_920);
  assert.ok(pasted);
  assert.deepEqual(pasted.parts, file.parts, "streamed paste must preserve every prepared source and mesh byte");
  assert.ok(worker.messages.some((message) => message.stage === "reading" && message.bytesRead === Buffer.byteLength(source)));

  const smallBuild = { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }, { x: 1, y: 0, z: 0, type: "glass" }] };
  const example = { ...smallBuild, blocks: smallBuild.blocks.slice(0, 1) };
  for (const text of [
    `\`\`\`json\n${JSON.stringify(smallBuild)}\n\`\`\``,
    `Example:\n${JSON.stringify(example)}\nResult:\n${JSON.stringify(smallBuild)}`,
  ]) {
    const wrapped = startWorker();
    await wrapped.parse(text);
    assert.equal(completedBuild(wrapped.messages).world!.manifest.exactBlockCount, 2);
    assert.equal(wrapped.inputs.length, 2, "model-output extraction should follow a source-format rejection");
  }

  const tool = { tool: "voxel.exec", input: { code: "return build", gridSize: 8192, palette: "advanced" } };
  let executions = 0;
  const toolWorker: ReturnType<typeof startWorker> = startWorker(undefined, async (_input, init) => {
    executions += 1;
    assert.equal(toolWorker.messages.filter((message) => message.type === "progress").at(-1)?.stage, undefined);
    assert.deepEqual(JSON.parse(String(init?.body)), tool.input);
    return Response.json({ build: { version: "1.0", blocks: [{ x: 8191, y: 0, z: 0, type: "stone" }] }, warnings: [] });
  });
  await toolWorker.parse(`Model output:\n${JSON.stringify(example)}\n\`\`\`json\n${JSON.stringify(tool)}\n\`\`\``);
  const toolBuild = completedBuild(toolWorker.messages);
  assert.equal(executions, 1);
  assert.equal(toolBuild.world!.manifest.gridSize, 8192);
  assert.equal(toolBuild.world!.manifest.palette, "advanced");
  assert.equal(toolBuild.world!.manifest.exactBlockCount, 1);

  let largeToolCalls = 0;
  const largeTool = startWorker(undefined, async () => {
    largeToolCalls += 1;
    return Response.json({ build: smallBuild, warnings: [] });
  });
  await largeTool.parse(JSON.stringify({ ...tool, metadata: "x".repeat(1_000_001) }));
  assert.equal(largeToolCalls, 1, "oversized ignored wrapper fields must preserve tool extraction");
  assert.equal(completedBuild(largeTool.messages).world!.manifest.exactBlockCount, 2);

  for (const [block, error] of [
    [{ x: 0, y: 0, z: 0, type: "x".repeat(1_000_001) }, "Build entry is too large"],
    [{ x: 32768, y: 0, z: 0, type: "stone" }, "Block coordinate is outside the supported integer range"],
  ] as const) {
    const bounded = startWorker();
    await bounded.parse(JSON.stringify({ version: "1.0", blocks: [block] }));
    assert.equal(bounded.inputs.length, 1);
    assert.equal(bounded.maxJsonParseChars, 0, "legacy parsing must not bypass source limits");
    assert.equal(bounded.messages.find((message) => message.type === "error")?.message, error);
  }

  const invalid = startWorker();
  await invalid.parse('{"version":"1.0","blocks":[{"x":"bad","y":0,"z":0,"type":"stone"}]}');
  assert.ok(invalid.messages.some((message) => message.type === "error"));
  assert.ok(invalid.messages.every((message) => message.type !== "complete"));
  await assert.rejects(localWorld.createLocalVoxelWorldForTest(new Blob(["bad JSON"]), worldOptions), localWorld.LocalVoxelWorldSourceError);
  const readError = new Error("file read failed");
  await assert.rejects(localWorld.createLocalVoxelWorldForTest({ stream: () => new ReadableStream({ start(controller) { controller.error(readError); } }) }, worldOptions), (error) => error === readError);
  await assert.rejects(localWorld.createLocalVoxelWorldForTest({ stream() { throw readError; } }, worldOptions), (error) => error === readError);

  for (const error of [new DOMException("quota exhausted", "QuotaExceededError"), new Error("mesh failed"), new RangeError("allocation failed")]) {
    const failed = startWorker(async () => { throw error; });
    await failed.parse(JSON.stringify(smallBuild));
    assert.equal(failed.inputs.length, 1, "storage and resource failures must not repeat parsing");
    assert.equal(failed.messages.find((message) => message.type === "error")?.message, error.message);
  }

  const canceled = startWorker(async (_input, opts) => {
    await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
    opts.signal!.throwIfAborted();
    throw new Error("cancellation did not abort");
  });
  const pending = canceled.parse(source);
  await canceled.cancel();
  await pending;
  assert.equal(canceled.inputs.length, 1);
  assert.ok(canceled.messages.every((message) => message.type !== "complete"));
  console.log("local build worker streamed paste checks passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
