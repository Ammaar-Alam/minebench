#!/usr/bin/env -S tsx

// Measures the proposed binary v4 build encoding against the current
// gzip-JSON v3 shape on real cohort builds. Read-only; writes nothing.
// See .agents/binary-v4-rfc-2026-08-13.md for the format spec and results.

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseVoxelBuildSpec } from "../lib/voxel/validate";

type VoxelBlock = { x: number; y: number; z: number; type: string };
type VoxelBuild = { version: string; blocks: VoxelBlock[] };

const MAGIC = 0x4d425634; // "MBV4"

function encodeV4(build: VoxelBuild): Uint8Array {
  const blocks = build.blocks;
  const typeNames: string[] = [];
  const typeIdByName = new Map<string, number>();
  const typeIds = new Uint16Array(blocks.length);
  const positions = new Uint16Array(blocks.length * 3);

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    positions[i * 3] = block.x;
    positions[i * 3 + 1] = block.y;
    positions[i * 3 + 2] = block.z;
    let typeId = typeIdByName.get(block.type);
    if (typeId === undefined) {
      typeId = typeNames.length;
      typeNames.push(block.type);
      typeIdByName.set(block.type, typeId);
    }
    typeIds[i] = typeId;
  }

  const paletteBytes = Buffer.from(JSON.stringify(typeNames), "utf8");
  const header = Buffer.alloc(16);
  header.writeUInt32BE(MAGIC, 0);
  header.writeUInt8(4, 4); // format version
  header.writeUInt8(0, 5); // flags
  header.writeUInt16BE(paletteBytes.byteLength, 6);
  header.writeUInt32BE(blocks.length, 8);
  header.writeUInt32BE(0, 12); // reserved (source checksum prefix in the real format)

  return Buffer.concat([
    header,
    paletteBytes,
    Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
    Buffer.from(typeIds.buffer, typeIds.byteOffset, typeIds.byteLength),
  ]);
}

function decodeV4(bytes: Uint8Array): VoxelBuild {
  const buf = Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  if (buf.readUInt32BE(0) !== MAGIC) throw new Error("bad magic");
  const paletteLength = buf.readUInt16BE(6);
  const blockCount = buf.readUInt32BE(8);
  const typeNames = JSON.parse(buf.subarray(16, 16 + paletteLength).toString("utf8")) as string[];
  const positionsOffset = 16 + paletteLength;
  const typeIdsOffset = positionsOffset + blockCount * 6;
  // array payloads are little-endian, matching typed-array memory layout
  const positions = new Uint16Array(blockCount * 3);
  const typeIds = new Uint16Array(blockCount);
  for (let i = 0; i < blockCount * 3; i += 1) {
    positions[i] = buf.readUInt16LE(positionsOffset + i * 2);
  }
  for (let i = 0; i < blockCount; i += 1) {
    typeIds[i] = buf.readUInt16LE(typeIdsOffset + i * 2);
  }
  const blocks: VoxelBlock[] = new Array(blockCount);
  for (let i = 0; i < blockCount; i += 1) {
    blocks[i] = {
      x: positions[i * 3],
      y: positions[i * 3 + 1],
      z: positions[i * 3 + 2],
      type: typeNames[typeIds[i]],
    };
  }
  return { version: "1.0", blocks };
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)}MiB`;
  return `${(bytes / 1024).toFixed(1)}KiB`;
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: tsx scripts/prototype-binary-v4.ts <build.json> [more.json ...]");
    process.exitCode = 1;
    return;
  }

  console.log(
    "file | blocks | raw json | gzip json (v3) | gzip v4 | transfer delta | json decode | v4 decode",
  );
  for (const file of files) {
    const raw = readFileSync(file);
    // uploads hold the model's box/block spec; delivery serves expanded blocks
    const parsed = parseVoxelBuildSpec(JSON.parse(raw.toString("utf8")));
    if (!parsed.ok) {
      console.error(`- ${file}: ${parsed.error}, skipping`);
      continue;
    }
    const build = parsed.value as VoxelBuild;

    const jsonBytes = Buffer.from(JSON.stringify(build));
    const gzipJson = timed(() => gzipSync(jsonBytes));
    const v4 = encodeV4(build);
    const gzipV4 = timed(() => gzipSync(v4));

    const jsonDecode = timed(() => JSON.parse(gunzipSync(gzipJson.value).toString("utf8")) as VoxelBuild);
    const v4Decode = timed(() => decodeV4(gunzipSync(gzipV4.value)));

    if (v4Decode.value.blocks.length !== build.blocks.length) {
      throw new Error(`v4 roundtrip lost blocks in ${file}`);
    }
    for (const i of [0, Math.floor(build.blocks.length / 2), build.blocks.length - 1]) {
      const a = build.blocks[i];
      const b = v4Decode.value.blocks[i];
      if (a.x !== b.x || a.y !== b.y || a.z !== b.z || a.type !== b.type) {
        throw new Error(`v4 roundtrip mismatch at index ${i} in ${file}`);
      }
    }

    const delta = 1 - gzipV4.value.byteLength / gzipJson.value.byteLength;
    console.log(
      [
        file.split("/").pop(),
        build.blocks.length.toLocaleString(),
        fmtBytes(jsonBytes.byteLength),
        fmtBytes(gzipJson.value.byteLength),
        fmtBytes(gzipV4.value.byteLength),
        `${(delta * 100).toFixed(1)}%`,
        `${jsonDecode.ms.toFixed(0)}ms`,
        `${v4Decode.ms.toFixed(0)}ms`,
      ].join(" | "),
    );
  }
}

main();
