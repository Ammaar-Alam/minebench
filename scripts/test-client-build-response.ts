import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  isGzipChunk,
  isGzipStreamPrefix,
  readBuildVariantJson,
  streamFromInitialChunks,
} from "../lib/arena/clientBuildResponse";

async function main() {
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

  const gzipped = gzipSync(Buffer.from(JSON.stringify(payload)));
  const response = new Response(gzipped, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

  const decoded = await readBuildVariantJson<typeof payload>(response);

  assert.deepEqual(decoded, payload);

  const ndjsonPayload = [
    JSON.stringify({ type: "hello", buildId: "test-build", variant: "preview" }),
    JSON.stringify({ type: "complete", totalBlocks: 0 }),
    "",
  ].join("\n");
  const gzippedStream = new Uint8Array(gzipSync(Buffer.from(ndjsonPayload)));
  assert.equal(isGzipChunk(gzippedStream), true);

  const initialChunks = [gzippedStream.slice(0, 1), gzippedStream.slice(1, 2)];
  assert.equal(isGzipStreamPrefix(initialChunks), true);

  const rest = gzippedStream.slice(2);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(rest);
      controller.close();
    },
  });
  const reader = source.getReader();
  const reconstructed = streamFromInitialChunks(initialChunks, reader).pipeThrough(
    new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  const decodedStream = await new Response(reconstructed).text();

  assert.equal(decodedStream, ndjsonPayload);

  const encoder = new TextEncoder();
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

  const firstReplay = await backpressureReader.read();
  assert.equal(new TextDecoder().decode(firstReplay.value), "a");
  assert.ok(sourceReadCount < 3);

  const secondReplay = await backpressureReader.read();
  assert.equal(new TextDecoder().decode(secondReplay.value), "b");
  assert.ok(sourceReadCount < 3);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
