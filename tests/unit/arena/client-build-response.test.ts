import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

const encoder = new TextEncoder();

function ndjson(...events: unknown[]): Uint8Array {
  return encoder.encode(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function successfulEvents() {
  const blocks = [
    { x: 1, y: 2, z: 3, type: "stone" },
    { x: 4, y: 5, z: 6, type: "glass" },
  ];
  return {
    blocks,
    events: [
      { type: "ping", ts: 1 },
      {
        type: "hello",
        buildId: "test-build",
        variant: "full",
        checksum: "test-checksum",
        serverValidated: true,
        totalBlocks: 2,
        chunkCount: 2,
        chunkBlockCount: 1,
        estimatedBytes: 100,
        source: "artifact",
      },
      {
        type: "chunk",
        index: 1,
        chunkCount: 2,
        receivedBlocks: 1,
        totalBlocks: 2,
        blocks: blocks.slice(0, 1),
      },
      {
        type: "chunk",
        index: 2,
        chunkCount: 2,
        receivedBlocks: 2,
        totalBlocks: 2,
        blocks: blocks.slice(1),
      },
      { type: "complete", totalBlocks: 2, durationMs: 10 },
    ],
  };
}

function responseFromChunks(
  chunks: Uint8Array[],
  hooks?: { onCancel?: () => void },
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
      cancel() {
        hooks?.onCancel?.();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
}

async function main() {
  process.env.NEXT_PUBLIC_ARENA_STREAM_FIRST_EVENT_TIMEOUT_MS = "20";
  process.env.NEXT_PUBLIC_ARENA_STREAM_STALL_TIMEOUT_MS = "20";
  process.env.NEXT_PUBLIC_ARENA_STREAM_HARD_TIMEOUT_MS = "60";

  const {
    IncompleteBuildStreamError,
    isGzipChunk,
    isGzipStreamPrefix,
    readBuildVariantArtifact,
    readBuildVariantJson,
    readBuildVariantStream,
    streamFromInitialChunks,
  } = await import("../../../lib/arena/clientBuildResponse");

  const payload = {
    buildId: "test-build",
    variant: "preview",
    checksum: "test-checksum",
    serverValidated: true,
    voxelBuild: {
      version: "1.0",
      blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
    },
  };
  const gzippedJson = gzipSync(Buffer.from(JSON.stringify(payload)));
  const decodedJson = await readBuildVariantJson<typeof payload>(new Response(gzippedJson));
  assert.deepEqual(decodedJson, payload);

  const jsonArtifactStages: string[] = [];
  const jsonArtifact = await readBuildVariantArtifact<typeof payload>(new Response(gzippedJson), {
    onStage(event) {
      jsonArtifactStages.push(event.stage);
    },
  });
  assert.equal(jsonArtifact.kind, "json");
  assert.deepEqual(jsonArtifactStages, [
    "body_complete",
    "inflate_complete",
    "json_decode_complete",
  ]);

  const { encodeBinaryArtifact } = await import("../../../lib/arena/binaryArtifact");
  const binaryArtifactStages: string[] = [];
  const encodedBinaryArtifact = encodeBinaryArtifact(
    { buildId: "test-build", variant: "preview", serverValidated: true },
    payload.voxelBuild.blocks,
  );
  const binaryArtifact = await readBuildVariantArtifact(
    new Response(
      encodedBinaryArtifact.buffer.slice(
        encodedBinaryArtifact.byteOffset,
        encodedBinaryArtifact.byteOffset + encodedBinaryArtifact.byteLength,
      ) as ArrayBuffer,
    ),
    {
      onStage(event) {
        binaryArtifactStages.push(event.stage);
      },
    },
  );
  assert.equal(binaryArtifact.kind, "binary");
  assert.deepEqual(binaryArtifactStages, [
    "body_complete",
    "inflate_complete",
    "binary_decode_complete",
  ]);

  const { blocks, events } = successfulEvents();
  const progressBuilds: object[] = [];
  const streamStages: string[] = [];
  const progress: Array<{
    receivedBlocks: number;
    totalBlocks: number | null;
    chunkIndex: number | null;
    chunkCount: number | null;
  }> = [];
  const plainResponse = responseFromChunks([ndjson(...events)]);
  const decoded = await readBuildVariantStream(plainResponse, {
    onStage(stage) {
      streamStages.push(stage);
    },
    onProgress(build, value) {
      progressBuilds.push(build);
      progress.push(value);
    },
  });
  assert.equal(decoded.buildId, "test-build");
  assert.equal(decoded.variant, "full");
  assert.equal(decoded.checksum, "test-checksum");
  assert.equal(decoded.serverValidated, true);
  assert.equal(decoded.voxelBuild.packed?.count, 2);
  assert.deepEqual(
    decoded.voxelBuild.packed?.positions.slice(0, 6),
    new Int16Array([1, 2, 3, 4, 5, 6]),
  );
  assert.deepEqual(decoded.voxelBuild.packed?.typeNames, ["stone", "glass"]);
  assert.ok(progressBuilds.length >= 3);
  assert.ok(progressBuilds.every((build) => build === progressBuilds[0]));
  assert.equal(progress.at(-1)?.receivedBlocks, blocks.length);
  assert.equal(progress.at(-1)?.totalBlocks, blocks.length);
  assert.equal(progress.at(-1)?.chunkIndex, 2);
  assert.equal(progress.at(-1)?.chunkCount, 2);
  assert.equal(plainResponse.body?.locked, false);
  assert.deepEqual(streamStages, ["body_complete", "stream_decode_complete"]);

  const repeatedHello = await readBuildVariantStream(
    responseFromChunks([
      ndjson(
        { ...events[1], checksum: null, serverValidated: false, source: "live" },
        events[1],
        ...events.slice(2),
      ),
    ]),
  );
  assert.equal(repeatedHello.serverValidated, true);
  assert.equal(repeatedHello.checksum, "test-checksum");

  const gzippedStream = new Uint8Array(gzipSync(Buffer.from(ndjson(...events))));
  assert.equal(isGzipChunk(gzippedStream), true);
  assert.equal(isGzipStreamPrefix([gzippedStream.slice(0, 1), gzippedStream.slice(1, 2)]), true);
  const compressedResponse = responseFromChunks([
    gzippedStream.slice(0, 1),
    gzippedStream.slice(1, 2),
    gzippedStream.slice(2),
  ]);
  const compressed = await readBuildVariantStream(compressedResponse);
  assert.equal(compressed.voxelBuild.packed?.count, 2);
  assert.equal(compressedResponse.body?.locked, false);

  const decompressionStream = globalThis.DecompressionStream;
  const unsupportedCompressedResponse = responseFromChunks([gzippedStream]);
  try {
    Object.defineProperty(globalThis, "DecompressionStream", {
      configurable: true,
      value: undefined,
    });
    await assert.rejects(
      readBuildVariantStream(unsupportedCompressedResponse),
      /Compressed build artifact is not supported by this browser/,
    );
    assert.equal(unsupportedCompressedResponse.body?.locked, false);
  } finally {
    Object.defineProperty(globalThis, "DecompressionStream", {
      configurable: true,
      value: decompressionStream,
    });
  }

  let sourceReadCount = 0;
  const sourceChunks = ["b", "c", "d"];
  const backpressureSource = {
    async read() {
      sourceReadCount += 1;
      const next = sourceChunks.shift();
      return next == null
        ? { done: true as const, value: undefined }
        : { done: false as const, value: encoder.encode(next) };
    },
    async cancel() {},
    releaseLock() {},
  } as ReadableStreamDefaultReader<Uint8Array>;
  const backpressureReader = streamFromInitialChunks(
    [encoder.encode("a")],
    backpressureSource,
  ).getReader();
  assert.equal(new TextDecoder().decode((await backpressureReader.read()).value), "a");
  assert.ok(sourceReadCount < 3);
  assert.equal(new TextDecoder().decode((await backpressureReader.read()).value), "b");
  assert.ok(sourceReadCount < 3);
  await backpressureReader.cancel();

  await assert.rejects(
    readBuildVariantStream(responseFromChunks([encoder.encode('{"type":"hello"\n')])),
    /Malformed build stream event/,
  );
  await assert.rejects(
    readBuildVariantStream(
      responseFromChunks([
        ndjson(
          events[1],
          {
            type: "chunk",
            index: 1,
            chunkCount: 1,
            receivedBlocks: 1,
            totalBlocks: 1,
            blocks: [{ x: 0, y: 0, z: 0, type: 4 }],
          },
        ),
      ]),
    ),
    /Invalid build stream block/,
  );
  await assert.rejects(
    readBuildVariantStream(
      responseFromChunks([ndjson(events[1], { type: "error", message: "artifact failed" })]),
    ),
    /artifact failed/,
  );

  const incompleteResponse = responseFromChunks([ndjson(events[1], events[2])]);
  await assert.rejects(
    readBuildVariantStream(incompleteResponse),
    (error: unknown) => error instanceof IncompleteBuildStreamError,
  );
  assert.equal(incompleteResponse.body?.locked, false);
  await assert.rejects(
    readBuildVariantStream(
      responseFromChunks([
        ndjson(
          { ...events[1], totalBlocks: 3 },
          { ...events[2], totalBlocks: 3 },
          { type: "complete", totalBlocks: 3, durationMs: 1 },
        ),
      ]),
    ),
    (error: unknown) => error instanceof IncompleteBuildStreamError,
  );

  let firstTimeoutCancelled = 0;
  const firstTimeoutResponse = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        firstTimeoutCancelled += 1;
      },
    }),
  );
  await assert.rejects(readBuildVariantStream(firstTimeoutResponse), /before the first event/);
  assert.equal(firstTimeoutCancelled, 1);
  assert.equal(firstTimeoutResponse.body?.locked, false);

  let stallCancelled = 0;
  let sentHello = false;
  const stallResponse = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentHello) {
          sentHello = true;
          controller.enqueue(ndjson(events[1]));
          return;
        }
        return new Promise(() => undefined);
      },
      cancel() {
        stallCancelled += 1;
      },
    }),
  );
  await assert.rejects(readBuildVariantStream(stallResponse), /stalled/);
  assert.equal(stallCancelled, 1);
  assert.equal(stallResponse.body?.locked, false);

  let hardTimeoutCancelled = 0;
  const hardTimeoutResponse = new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.enqueue(ndjson({ type: "ping", ts: Date.now() }));
      },
      cancel() {
        hardTimeoutCancelled += 1;
      },
    }),
  );
  await assert.rejects(readBuildVariantStream(hardTimeoutResponse), /hard timeout/);
  assert.equal(hardTimeoutCancelled, 1);
  assert.equal(hardTimeoutResponse.body?.locked, false);

  let abortCancelled = 0;
  const abortController = new AbortController();
  const abortResponse = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        abortCancelled += 1;
      },
    }),
  );
  setTimeout(() => abortController.abort(), 5);
  await assert.rejects(
    readBuildVariantStream(abortResponse, { signal: abortController.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(abortCancelled, 1);
  assert.equal(abortResponse.body?.locked, false);

  const sourceFailureResponse = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("source failed"));
      },
    }),
  );
  await assert.rejects(readBuildVariantStream(sourceFailureResponse), /source failed/);
  assert.equal(sourceFailureResponse.body?.locked, false);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
