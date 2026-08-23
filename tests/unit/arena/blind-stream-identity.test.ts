import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

const encoder = new TextEncoder();

async function main() {
  process.env.ARENA_STREAM_ARTIFACTS_ENABLED = "0";

  const { rewriteBlindArenaBuildStreamIdentity } = await import(
    "../../../lib/arena/buildStream"
  );
  const { readBuildVariantStream } = await import(
    "../../../lib/arena/clientBuildResponse"
  );

  const blocks = [{ x: 1, y: 2, z: 3, type: "stone" }];
  const body = encoder.encode(
    [
      {
        type: "hello",
        buildId: "real-build-id",
        variant: "full",
        checksum: "real-checksum",
        serverValidated: true,
        totalBlocks: 1,
        chunkCount: 1,
        chunkBlockCount: 1,
        estimatedBytes: 34,
        source: "artifact",
      },
      {
        type: "chunk",
        index: 1,
        chunkCount: 1,
        receivedBlocks: 1,
        totalBlocks: 1,
        blocks,
      },
      { type: "complete", totalBlocks: 1, durationMs: 0 },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const compressed = new Uint8Array(gzipSync(body));
  const artifact = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed.slice(0, 1));
      controller.enqueue(compressed.slice(1));
      controller.close();
    },
  });

  const rewritten = await rewriteBlindArenaBuildStreamIdentity(artifact, "b1.blind-build");
  const decoded = await readBuildVariantStream(new Response(rewritten));

  assert.equal(decoded.buildId, "b1.blind-build");
  assert.equal(decoded.checksum, null);
  assert.equal(decoded.voxelBuild.packed?.count, 1);
  assert.equal(decoded.voxelBuild.packed?.typeNames[0], "stone");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
