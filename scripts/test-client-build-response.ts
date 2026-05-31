import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  isGzipChunk,
  readBuildVariantJson,
  streamFromFirstChunk,
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

  const firstChunk = gzippedStream.slice(0, 8);
  const rest = gzippedStream.slice(8);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(rest);
      controller.close();
    },
  });
  const reader = source.getReader();
  const reconstructed = streamFromFirstChunk(firstChunk, reader).pipeThrough(
    new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  const decodedStream = await new Response(reconstructed).text();

  assert.equal(decodedStream, ndjsonPayload);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
