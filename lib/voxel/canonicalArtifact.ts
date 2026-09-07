import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGzip } from "node:zlib";
import { isPackedVoxelBlocks } from "@/lib/voxel/packedBlocks";
import type { VoxelBlock, VoxelBuild } from "@/lib/voxel/types";

const ENCODER = new TextEncoder();
const SOURCE_BUILD_GZIP_LEVEL = zlibConstants.Z_BEST_SPEED;
type BuildJsonSource = Omit<VoxelBuild, "blocks"> & { blocks: Iterable<VoxelBlock> };

function* jsonArrayChunks(
  prefix: string,
  values: Iterable<string>,
  suffix: string,
): Generator<Uint8Array> {
  let chunk = prefix;
  let index = 0;
  for (const value of values) {
    const item = `${index === 0 ? "" : ","}${value}`;
    if (chunk.length + item.length > 64 * 1024) {
      yield ENCODER.encode(chunk);
      chunk = item;
    } else {
      chunk += item;
    }
    index += 1;
  }
  yield ENCODER.encode(`${chunk}${suffix}`);
}

function* objectJson(values: Iterable<unknown>): Generator<string> {
  for (const value of values) yield JSON.stringify(value);
}

function* blockJson(build: BuildJsonSource): Generator<string> {
  yield* objectJson(build.blocks);
  if (build.packed === undefined) return;
  if (!isPackedVoxelBlocks(build.packed)) throw new Error("Invalid packed voxel blocks");
  for (let index = 0; index < build.packed.count; index += 1) {
    yield JSON.stringify({
      x: build.packed.positions[index * 3],
      y: build.packed.positions[index * 3 + 1],
      z: build.packed.positions[index * 3 + 2],
      type: build.packed.typeNames[build.packed.typeIds[index]!],
    });
  }
}

export function* canonicalBuildJsonChunks(build: BuildJsonSource): Generator<Uint8Array> {
  yield* jsonArrayChunks('{"version":"1.0","blocks":[', blockJson(build), "]}");
}

export function* voxelBuildSourceJsonChunks(build: VoxelBuild): Generator<Uint8Array> {
  yield ENCODER.encode('{"version":"1.0"');
  if (build.boxes?.length) {
    yield* jsonArrayChunks(',"boxes":[', objectJson(build.boxes), "]");
  }
  if (build.lines?.length) {
    yield* jsonArrayChunks(',"lines":[', objectJson(build.lines), "]");
  }
  yield* jsonArrayChunks(',"blocks":[', blockJson(build), "]}");
}

async function removeArtifactFile(directory: string, filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await rmdir(directory);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

export type WrittenBuildArtifact = {
  filePath: string;
  byteSize: number;
  storedByteSize: number;
  sha256: string;
  sourceSha256: string;
  cleanup: () => Promise<void>;
};

export type BuildSourceArtifactWriter = {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<WrittenBuildArtifact>;
  abort: () => Promise<void>;
};

async function createBuildArtifactWriter(
  fileName: string,
  gzipLevel?: number,
): Promise<BuildSourceArtifactWriter> {
  const directory = await mkdtemp(path.join(tmpdir(), "minebench-build-"));
  const filePath = path.join(directory, fileName);
  const sourceHash = createHash("sha256");
  const storedHash = createHash("sha256");
  let byteSize = 0;
  let storedByteSize = 0;
  let cleaned = false;
  let closed = false;
  let aborted = false;
  let artifact: WrittenBuildArtifact | null = null;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await removeArtifactFile(directory, filePath);
  };
  const compressor = gzipLevel === undefined ? createGzip() : createGzip({ level: gzipLevel });
  const done = pipeline(
    compressor,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        storedHash.update(chunk);
        storedByteSize += chunk.byteLength;
        callback(null, chunk);
      },
    }),
    createWriteStream(filePath, { flags: "wx" }),
  );
  void done.catch(() => undefined);

  const abort = async () => {
    if (aborted) return;
    aborted = true;
    if (!closed) compressor.destroy(new Error("Build source artifact write aborted"));
    await done.catch(() => undefined);
    await cleanup();
  };

  return {
    async write(chunk) {
      if (closed || aborted) throw new Error("Build source artifact writer is closed");
      sourceHash.update(chunk);
      byteSize += chunk.byteLength;
      await new Promise<void>((resolve, reject) => {
        compressor.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    async close() {
      if (artifact) return artifact;
      if (aborted) throw new Error("Build source artifact writer was aborted");
      closed = true;
      compressor.end();
      try {
        await done;
      } catch (error) {
        await cleanup();
        throw error;
      }
      artifact = {
        filePath,
        byteSize,
        storedByteSize,
        sha256: storedHash.digest("hex"),
        sourceSha256: sourceHash.digest("hex"),
        cleanup,
      };
      return artifact;
    },
    abort,
  };
}

async function writeBuildArtifactFile(
  chunks: Iterable<Uint8Array>,
  fileName: string,
  gzipLevel?: number,
): Promise<WrittenBuildArtifact> {
  const writer = await createBuildArtifactWriter(fileName, gzipLevel);
  try {
    for (const chunk of chunks) await writer.write(chunk);
    return await writer.close();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

export async function writeCanonicalBuildArtifact(build: VoxelBuild): Promise<WrittenBuildArtifact> {
  return writeBuildArtifactFile(canonicalBuildJsonChunks(build), "build.json.gz");
}

export async function writeVoxelBuildSourceArtifact(build: VoxelBuild): Promise<WrittenBuildArtifact> {
  return writeBuildArtifactFile(voxelBuildSourceJsonChunks(build), "source.json.gz", SOURCE_BUILD_GZIP_LEVEL);
}

export async function createVoxelBuildSourceArtifactWriter(): Promise<BuildSourceArtifactWriter> {
  return createBuildArtifactWriter("source.json.gz", SOURCE_BUILD_GZIP_LEVEL);
}
