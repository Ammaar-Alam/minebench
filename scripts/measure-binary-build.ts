#!/usr/bin/env -S tsx

import "dotenv/config";
import { gzipSync } from "node:zlib";
import { encodeBinaryVoxelBuild, decodeBinaryVoxelBuild } from "../lib/voxel/binaryBuild";
import { getPalette } from "../lib/blocks/palettes";
import { resolveBuildPayload } from "../lib/storage/buildPayload";
import { validateVoxelBuild } from "../lib/voxel/validate";
import { filterRenderableVoxelBuild } from "../lib/voxel/renderVisibility";
import { prisma } from "../lib/prisma";

/**
 * Compare the binary encoding against the gzip JSON delivery it would replace,
 * on real cohort builds rather than generated ones. Synthetic blocks compress
 * far better than real geometry and overstate the result badly, so this reads
 * the same payloads delivery serves.
 *
 * Usage: pnpm tsx scripts/measure-binary-build.ts [--limit 6] [--prompt <text>]
 */

function kib(bytes: number): string {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(2)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > -1 ? Number.parseInt(process.argv[limitArg + 1] ?? "6", 10) : 6;
  const promptArg = process.argv.indexOf("--prompt");
  const promptFilter = promptArg > -1 ? process.argv[promptArg + 1] : null;

  const builds = await prisma.build.findMany({
    where: {
      blockCount: { gt: 0 },
      ...(promptFilter ? { prompt: { text: { contains: promptFilter } } } : {}),
    },
    orderBy: { blockCount: "desc" },
    take: limit,
    select: {
      id: true,
      voxelData: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
      voxelStorageEncoding: true,
      voxelSha256: true,
      model: { select: { displayName: true } },
      prompt: { select: { text: true } },
    },
  });

  const palette = getPalette("advanced");
  let totalJson = 0;
  let totalBinary = 0;

  for (const row of builds) {
    const validated = validateVoxelBuild(await resolveBuildPayload(row), {
      gridSize: 256,
      palette,
      maxBlocks: Number.MAX_SAFE_INTEGER,
    });
    if (!validated.ok) {
      console.log(`${row.id}: could not validate (${validated.error})`);
      continue;
    }
    // delivery serves only the blocks that can emit a face
    const blocks = filterRenderableVoxelBuild(validated.value.build).blocks;

    // delivery serves the validated build as gzip JSON
    const json = Buffer.from(JSON.stringify({ version: "1.0", blocks }));
    const binary = Buffer.from(encodeBinaryVoxelBuild(blocks, row.voxelSha256));
    const jsonGz = gzipSync(json, { level: 9 });
    const binaryGz = gzipSync(binary, { level: 9 });

    const jsonStart = process.hrtime.bigint();
    JSON.parse(json.toString("utf8"));
    const jsonMs = Number(process.hrtime.bigint() - jsonStart) / 1e6;

    const binStart = process.hrtime.bigint();
    const decoded = decodeBinaryVoxelBuild(binary);
    const binMs = Number(process.hrtime.bigint() - binStart) / 1e6;
    if (decoded.count !== blocks.length) {
      throw new Error(`round trip lost blocks for ${row.id}`);
    }

    totalJson += jsonGz.byteLength;
    totalBinary += binaryGz.byteLength;

    console.log(
      [
        `${row.prompt.text.slice(0, 40)} | ${row.model.displayName}`,
        `  blocks ${blocks.length.toLocaleString()}`,
        `  wire   ${kib(jsonGz.byteLength)} -> ${kib(binaryGz.byteLength)} ` +
          `(${(((binaryGz.byteLength - jsonGz.byteLength) / jsonGz.byteLength) * 100).toFixed(1)}%)`,
        `  decode ${jsonMs.toFixed(0)}ms -> ${binMs.toFixed(0)}ms ` +
          `(${(jsonMs / Math.max(binMs, 0.001)).toFixed(1)}x)`,
      ].join("\n"),
    );
    console.log("");
  }

  if (totalJson > 0) {
    console.log(
      `total wire ${kib(totalJson)} -> ${kib(totalBinary)} ` +
        `(${(((totalBinary - totalJson) / totalJson) * 100).toFixed(1)}%)`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
