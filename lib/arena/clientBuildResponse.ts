import { decodeBinaryArtifact, isBinaryArtifact } from "@/lib/arena/binaryArtifact";
import type { PackedVoxelBlocks } from "@/lib/voxel/packedBlocks";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export function isGzipChunk(chunk: Uint8Array): boolean {
  return chunk.length >= 2 && chunk[0] === GZIP_MAGIC_0 && chunk[1] === GZIP_MAGIC_1;
}

function byteAt(chunks: readonly Uint8Array[], targetIndex: number): number | null {
  let offset = targetIndex;
  for (const chunk of chunks) {
    if (offset < chunk.length) return chunk[offset];
    offset -= chunk.length;
  }
  return null;
}

export function isGzipStreamPrefix(chunks: readonly Uint8Array[]): boolean {
  return byteAt(chunks, 0) === GZIP_MAGIC_0 && byteAt(chunks, 1) === GZIP_MAGIC_1;
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Compressed build artifact is not supported by this browser.");
  }
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const decompressor = new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
  const stream = new Blob([body]).stream().pipeThrough(decompressor);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readBuildVariantJson<T>(res: Response): Promise<T> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const body = isGzipChunk(bytes) ? await gunzipBytes(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

// A request for the binary artifact can still be answered with JSON: the
// binary object is written alongside the JSON one rather than replacing it, so
// a miss falls back. The body is therefore identified by what it is, not by
// what was asked for.
export type BuildVariantArtifact<T> =
  | { kind: "json"; value: T }
  | { kind: "binary"; envelope: Record<string, unknown>; blocks: PackedVoxelBlocks };

export async function readBuildVariantArtifact<T>(res: Response): Promise<BuildVariantArtifact<T>> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const body = isGzipChunk(bytes) ? await gunzipBytes(bytes) : bytes;
  if (isBinaryArtifact(body)) {
    const { envelope, blocks } = decodeBinaryArtifact(body);
    return { kind: "binary", envelope, blocks };
  }
  return { kind: "json", value: JSON.parse(new TextDecoder().decode(body)) as T };
}

export function streamFromInitialChunks(
  initialChunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let replayIndex = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (replayIndex < initialChunks.length) {
          controller.enqueue(initialChunks[replayIndex]);
          replayIndex += 1;
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value) {
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {
          // already canceled
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

export function streamFromFirstChunk(
  firstChunk: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return streamFromInitialChunks([firstChunk], reader);
}
