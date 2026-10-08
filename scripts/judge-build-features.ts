#!/usr/bin/env -S tsx
/**
 * Measure simple shape statistics for every build in a judge-data snapshot.
 *
 * Builds go through the same preparation the Arena serves as its full variant, so the
 * numbers describe the visible blocks voters saw. Writes <snapshot>/features.jsonl.
 *
 * Usage:
 *   pnpm judge:features --snapshot judge-data/2026-10-07
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { prepareArenaBuild } from "../lib/arena/buildArtifacts";
import { LOCAL_BUILD_STORAGE_BUCKET } from "../lib/storage/config";
import { packVoxelBlocks } from "../lib/voxel/packedBlocks";

type SnapshotBuild = {
  id: string;
  gridSize: number;
  palette: string;
  blockCount: number;
  payloadFile: string | null;
  payloadBytes: number | null;
};

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

async function main() {
  const snapshot = argValue("--snapshot");
  if (!snapshot) throw new Error("Pass --snapshot judge-data/<date>");
  const snapshotDir = path.resolve(snapshot);
  const builds = fs
    .readFileSync(path.join(snapshotDir, "builds.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SnapshotBuild)
    .filter((build) => build.payloadFile);

  const out = fs.openSync(path.join(snapshotDir, "features.jsonl.tmp"), "w");
  for (const [i, build] of builds.entries()) {
    const prepared = await prepareArenaBuild({
      id: build.id,
      gridSize: build.gridSize,
      palette: build.palette,
      blockCount: build.blockCount,
      voxelByteSize: build.payloadBytes,
      voxelCompressedByteSize: null,
      // no stored checksum keeps each build out of the arena's in-memory cache
      voxelSha256: null,
      voxelData: null,
      voxelStorageBucket: LOCAL_BUILD_STORAGE_BUCKET,
      voxelStoragePath: path.relative(process.cwd(), path.join(snapshotDir, build.payloadFile!)),
      voxelStorageEncoding: "gzip",
    });
    const { positions, typeIds, count } = prepared.fullBuild.packed ?? packVoxelBlocks(prepared.fullBuild.blocks);

    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let b = 0; b < count; b += 1) {
      const x = positions[b * 3]!, y = positions[b * 3 + 1]!, z = positions[b * 3 + 2]!;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const width = count ? maxX - minX + 1 : 0;
    const height = count ? maxY - minY + 1 : 0;
    const depth = count ? maxZ - minZ + 1 : 0;

    // occupancy bitset over the bounding box, at most 512^3 bits
    const occupied = new Uint8Array(Math.ceil((width * height * depth) / 8));
    const cell = (x: number, y: number, z: number) => ((x - minX) * height + (y - minY)) * depth + (z - minZ);
    const typeCounts = new Map<number, number>();
    for (let b = 0; b < count; b += 1) {
      const c = cell(positions[b * 3]!, positions[b * 3 + 1]!, positions[b * 3 + 2]!);
      occupied[c >> 3]! |= 1 << (c & 7);
      typeCounts.set(typeIds[b]!, (typeCounts.get(typeIds[b]!) ?? 0) + 1);
    }
    const has = (c: number) => (occupied[c >> 3]! & (1 << (c & 7))) !== 0;
    // share of visible blocks whose mirror across the build's center is also filled, best of the two horizontal axes
    let mirroredX = 0, mirroredZ = 0;
    for (let b = 0; b < count; b += 1) {
      const x = positions[b * 3]!, y = positions[b * 3 + 1]!, z = positions[b * 3 + 2]!;
      if (has(cell(minX + maxX - x, y, z))) mirroredX += 1;
      if (has(cell(x, y, minZ + maxZ - z))) mirroredZ += 1;
    }
    let typeEntropy = 0;
    for (const n of typeCounts.values()) typeEntropy -= (n / count) * Math.log2(n / count);

    fs.writeSync(out, `${JSON.stringify({
      id: build.id,
      totalBlocks: build.blockCount,
      visibleBlocks: count,
      width,
      height,
      depth,
      fill: count ? build.blockCount / (width * height * depth) : 0,
      visibleShare: build.blockCount ? count / build.blockCount : 0,
      typeCount: typeCounts.size,
      typeEntropy,
      symmetry: count ? Math.max(mirroredX, mirroredZ) / count : 0,
    })}\n`);
    if ((i + 1) % 100 === 0 || i + 1 === builds.length) console.log(`features ${i + 1}/${builds.length}`);
  }
  fs.closeSync(out);
  fs.renameSync(path.join(snapshotDir, "features.jsonl.tmp"), path.join(snapshotDir, "features.jsonl"));
}

// arena build caches hold open handles, so exit explicitly once done
main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
