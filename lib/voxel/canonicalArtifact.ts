import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { VoxelBuild } from "@/lib/voxel/types";

const ENCODER = new TextEncoder();

function* canonicalBuildJsonChunks(build: VoxelBuild): Generator<Uint8Array> {
  let chunk = '{"version":"1.0","blocks":[';
  for (let index = 0; index < build.blocks.length; index += 1) {
    const block = `${index === 0 ? "" : ","}${JSON.stringify(build.blocks[index])}`;
    if (chunk.length + block.length > 64 * 1024) {
      yield ENCODER.encode(chunk);
      chunk = block;
    } else {
      chunk += block;
    }
  }
  yield ENCODER.encode(`${chunk}]}`);
}

function* compactBuildJsonChunks(build: VoxelBuild): Generator<Uint8Array> {
  yield ENCODER.encode('{"version":"1.0"');
  if (build.boxes?.length) {
    let chunk = ',"boxes":[';
    for (let index = 0; index < build.boxes.length; index += 1) {
      const box = `${index === 0 ? "" : ","}${JSON.stringify(build.boxes[index])}`;
      if (chunk.length + box.length > 64 * 1024) {
        yield ENCODER.encode(chunk);
        chunk = box;
      } else {
        chunk += box;
      }
    }
    yield ENCODER.encode(`${chunk}]`);
  }
  if (build.lines?.length) {
    let chunk = ',"lines":[';
    for (let index = 0; index < build.lines.length; index += 1) {
      const line = `${index === 0 ? "" : ","}${JSON.stringify(build.lines[index])}`;
      if (chunk.length + line.length > 64 * 1024) {
        yield ENCODER.encode(chunk);
        chunk = line;
      } else {
        chunk += line;
      }
    }
    yield ENCODER.encode(`${chunk}]`);
  }
  let chunk = ',"blocks":[';
  for (let index = 0; index < build.blocks.length; index += 1) {
    const block = `${index === 0 ? "" : ","}${JSON.stringify(build.blocks[index])}`;
    if (chunk.length + block.length > 64 * 1024) {
      yield ENCODER.encode(chunk);
      chunk = block;
    } else {
      chunk += block;
    }
  }
  yield ENCODER.encode(`${chunk}]}`);
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

type WrittenBuildArtifact = {
  filePath: string;
  byteSize: number;
  storedByteSize: number;
  sha256: string;
  sourceSha256: string;
  cleanup: () => Promise<void>;
};

async function writeBuildArtifactFile(
  chunks: Generator<Uint8Array>,
  fileName: string,
): Promise<WrittenBuildArtifact> {
  const directory = await mkdtemp(path.join(tmpdir(), "minebench-build-"));
  const filePath = path.join(directory, fileName);
  const sourceHash = createHash("sha256");
  const storedHash = createHash("sha256");
  let byteSize = 0;
  let storedByteSize = 0;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await removeArtifactFile(directory, filePath);
  };
  try {
    await pipeline(
      Readable.from(chunks),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sourceHash.update(chunk);
          byteSize += chunk.byteLength;
          callback(null, chunk);
        },
      }),
      createGzip(),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          storedHash.update(chunk);
          storedByteSize += chunk.byteLength;
          callback(null, chunk);
        },
      }),
      createWriteStream(filePath, { flags: "wx" }),
    );
    return {
      filePath,
      byteSize,
      storedByteSize,
      sha256: storedHash.digest("hex"),
      sourceSha256: sourceHash.digest("hex"),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function writeCanonicalBuildArtifact(build: VoxelBuild): Promise<WrittenBuildArtifact> {
  return writeBuildArtifactFile(canonicalBuildJsonChunks(build), "build.json.gz");
}

export async function writeVoxelBuildSourceArtifact(build: VoxelBuild): Promise<WrittenBuildArtifact> {
  return writeBuildArtifactFile(compactBuildJsonChunks(build), "source.json.gz");
}
