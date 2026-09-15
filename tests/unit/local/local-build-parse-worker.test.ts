import assert from "node:assert/strict";

type PostedMessage = {
  type: string;
  requestId?: number;
  voxelBuild?: unknown;
  warnings?: string[];
  receivedBlocks?: number;
  totalBlocks?: number | null;
  source?: string;
  message?: string;
  deltaBlocks?: unknown[];
};

const posted: PostedMessage[] = [];
const selfStub: { onmessage: ((ev: MessageEvent) => void) | null } = { onmessage: null };

type GridSize = 64 | 256 | 512;

function makeParseRequest(rawText: string, requestId: number): unknown {
  return {
    type: "parse",
    requestId,
    rawText,
    gridSize: 64,
    palette: "simple",
    maxBlocksByGrid: {
      64: 64 * 64 * 64,
      256: 256 * 256 * 256,
      512: 512 * 512 * 512,
    } satisfies Record<GridSize, number>,
  };
}

let nextRequestId = 1;

async function parseBuild(rawText: string): Promise<PostedMessage[]> {
  posted.length = 0;
  const requestId = nextRequestId++;
  selfStub.onmessage!({ data: makeParseRequest(rawText, requestId) } as unknown as MessageEvent);
  // The build-json path posts its messages synchronously inside runParse, but
  // runParse is async (fire-and-forget via `void runParse`). Flush tasks so any
  // trailing microtask (e.g. an awaited path) settles before we assert.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return posted.filter((m) => m.requestId === requestId);
}

function onlyComplete(messages: PostedMessage[]): PostedMessage {
  const complete = messages.find((m) => m.type === "complete");
  const error = messages.find((m) => m.type === "error");
  assert.ok(complete, `expected a complete message; got error: ${error?.message ?? "(none)"}`);
  assert.equal(error, undefined, `expected no error message; got: ${error?.message ?? "(none)"}`);
  return complete as PostedMessage;
}

function onlyError(messages: PostedMessage[]): PostedMessage {
  const error = messages.find((m) => m.type === "error");
  assert.ok(error, "expected an error message");
  return error as PostedMessage;
}

async function main() {
  (globalThis as Record<string, unknown>).self = selfStub;
  (globalThis as Record<string, unknown>).postMessage = (msg: unknown) => {
    posted.push(msg as PostedMessage);
  };

  await import("../../../components/local/localBuildParse.worker");

  assert.equal(typeof selfStub.onmessage, "function", "worker installed an onmessage handler");

  // --- THE BUG: stray top-level quote in preamble, blocks build (main path) ---
  // Exercises findArrayStart; the pre-fix scanner returned -1 here, routing to
  // a fallback that also failed, ultimately surfacing a user-facing error.
  {
    const raw =
      `Here is the " voxel build as JSON:\n` +
      JSON.stringify({
        version: "1.0",
        blocks: [
          { x: 0, y: 0, z: 0, type: "stone" },
          { x: 1, y: 0, z: 0, type: "stone" },
        ],
      });
    const complete = onlyComplete(await parseBuild(raw));
    assert.equal(complete.receivedBlocks, 2, "stray-quote blocks build should parse 2 blocks");
    assert.equal(complete.source, "build-json", "stray-quote blocks build uses streaming source");
  }

  // --- THE BUG: wrapped/wrapping quotes around the object -------------------
  {
    const raw = `Output "JSON": " ` + JSON.stringify({ version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] }) + ` "`;
    const complete = onlyComplete(await parseBuild(raw));
    assert.equal(complete.receivedBlocks, 1, "wrapped-quote build should parse 1 block");
  }

  // --- THE BUG: stray quote in preamble, boxes build (fallback path) ----------
  // PRIMITIVE_ARRAY_RE routes streamBlocksFromText to null, forcing the
  // parseTopLevelJsonObjects fallback; the pre-fix scanner found nothing here.
  {
    const raw =
      `Here is the " voxel build (boxes):\n` +
      JSON.stringify({
        version: "1.0",
        boxes: [{ x1: 0, y1: 0, z1: 0, x2: 3, y2: 0, z2: 0, type: "stone" }],
        lines: [],
        blocks: [],
      });
    const complete = onlyComplete(await parseBuild(raw));
    assert.ok(
      (complete.receivedBlocks ?? 0) > 0,
      "stray-quote boxes build should expand to blocks via the fallback path",
    );
  }

  // --- THE BUG: stray quote in preamble, lines build (fallback path) ---------

  {
    const raw =
      `Here " is your line build:\n` +
      JSON.stringify({
        version: "1.0",
        lines: [
          { from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 }, type: "oak_planks" },
        ],
        blocks: [],
      });
    const complete = onlyComplete(await parseBuild(raw));
    assert.ok(
      (complete.receivedBlocks ?? 0) > 0,
      "stray-quote lines build should expand to blocks via the fallback path",
    );
  }

  // --- Regression: clean blocks build (no preamble) still streams -----------

  {
    const raw = JSON.stringify({
      version: "1.0",
      blocks: [
        { x: 0, y: 0, z: 0, type: "stone" },
        { x: 1, y: 0, z: 0, type: "stone" },
        { x: 2, y: 0, z: 0, type: "stone" },
      ],
    });
    const complete = onlyComplete(await parseBuild(raw));
    assert.equal(complete.receivedBlocks, 3, "clean blocks build should parse 3 blocks");
    assert.equal(complete.source, "build-json", "clean blocks build uses streaming source");
  }

  // --- Regression: clean boxes build (no preamble) still works ---------------

  {
    const raw = JSON.stringify({
      version: "1.0",
      boxes: [{ x1: 0, y1: 0, z1: 0, x2: 2, y2: 0, z2: 0, type: "stone" }],
      lines: [],
      blocks: [],
    });
    const complete = onlyComplete(await parseBuild(raw));
    assert.ok((complete.receivedBlocks ?? 0) > 0, "clean boxes build should expand to blocks");
  }

  // --- Regression: escaped quotes / braces inside string values -------------
  // The block type must stay a valid palette entry ("stone"); escaped quotes
  // and stray braces live in an ignored `note` field, which still exercises the
  // streaming scanner's inString/escaped handling so the block object braces
  // are not miscounted by braces that appear inside the string value.
  {
    const raw = JSON.stringify({
      version: "1.0",
      blocks: [{ x: 0, y: 0, z: 0, type: "stone", note: 'a " {" } "' }],
    });
    const complete = onlyComplete(await parseBuild(raw));
    assert.equal(complete.receivedBlocks, 1, "escaped quotes/braces in string value should still parse");
  }

  // --- Regression: balanced quotes in preamble (was already passing) ---------

  {
    const raw =
      `Sure, here is "the" build as "JSON":\n` +
      JSON.stringify({ version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] });
    const complete = onlyComplete(await parseBuild(raw));
    assert.equal(complete.receivedBlocks, 1, "balanced-quote preamble should parse 1 block");
  }

  // --- Negative: garbage input still surfaces the worker's error message ----
  // Ensures the depth gate did not make the extractors accept arbitrary prose.
  {
    const error = onlyError(await parseBuild("just prose with no object at all"));
    assert.equal(
      error.message,
      "Could not find a valid JSON object. Paste the raw JSON if possible.",
    );
  }

  // --- Negative: stray quote alone with no object should still error ---------

  {
    const error = onlyError(await parseBuild(`" a stray quote and nothing else`));
    assert.equal(
      error.message,
      "Could not find a valid JSON object. Paste the raw JSON if possible.",
    );
  }

  console.log("local build parse worker checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
