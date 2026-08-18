#!/usr/bin/env -S tsx

import "dotenv/config";
import { getRenderKind } from "../lib/blocks/registry";
import { hasAtlasKey } from "../lib/blocks/atlas";
import { getTextureKey, type Face } from "../lib/blocks/textures";
import { isVoxelOccluder } from "../lib/voxel/renderVisibility";
import { resolveBuildPayload } from "../lib/storage/buildPayload";
import { validateVoxelBuild } from "../lib/voxel/validate";
import { getPalette } from "../lib/blocks/palettes";
import { prisma } from "../lib/prisma";

/**
 * Report what a build actually costs the renderer.
 *
 * Block counts describe the payload, not the frame: the mesher turns each
 * visible block face into four vertices of position, normal, uv, and colour
 * plus six indices, and that geometry is what the device has to hold. This
 * prints both so the two can be compared directly.
 *
 * Usage: pnpm tsx scripts/measure-mesh-cost.ts [--limit 6]
 */

const DIRS: ReadonlyArray<{ face: Face; dx: number; dy: number; dz: number }> = [
  { face: "east", dx: 1, dy: 0, dz: 0 },
  { face: "west", dx: -1, dy: 0, dz: 0 },
  { face: "north", dx: 0, dy: 0, dz: -1 },
  { face: "south", dx: 0, dy: 0, dz: 1 },
  { face: "up", dx: 0, dy: 1, dz: 0 },
  { face: "down", dx: 0, dy: -1, dz: 0 },
];

// mesh.ts packs coordinates into 10 bits per axis
function encodePosition(x: number, y: number, z: number): number {
  return (x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20);
}

// float position, normalized Int8 normal, normalized Uint16 uv, normalized
// Uint8 colour: 22 bytes per vertex, 4 vertices and 6 Uint32 indices per face
const BYTES_PER_FACE = (3 * 4 + 3 + 2 * 2 + 3) * 4 + 6 * 4;
// what the same face cost when every attribute was a float
const LEGACY_BYTES_PER_FACE = 11 * 4 * 4 + 6 * 4;
// and what the JS number array buckets cost transiently on top of that
const LEGACY_STAGING_BYTES_PER_FACE = 11 * 4 * 8 + 6 * 8;

function mib(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
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
      blockCount: true,
      voxelData: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
      voxelStorageEncoding: true,
      arenaBuildHints: true,
      model: { select: { displayName: true } },
      prompt: { select: { text: true } },
    },
  });

  const palette = getPalette("advanced");
  const allowed = new Set(palette.map((entry) => entry.id));

  for (const row of builds) {
    const payload = await resolveBuildPayload(row);
    const validated = validateVoxelBuild(payload, {
      gridSize: 256,
      palette,
      maxBlocks: Number.MAX_SAFE_INTEGER,
    });
    if (!validated.ok) {
      console.log(`${row.id}: could not validate (${validated.error})`);
      continue;
    }
    const blocks = validated.value.build.blocks;

    const blocksByPos = new Map<number, string>();
    for (const block of blocks) {
      if (!allowed.has(block.type)) continue;
      blocksByPos.set(encodePosition(block.x, block.y, block.z), block.type);
    }

    let faces = 0;
    let visibleBlocks = 0;
    for (const block of blocks) {
      if (!allowed.has(block.type)) continue;
      let emitted = 0;
      for (const d of DIRS) {
        const neighbor = blocksByPos.get(
          encodePosition(block.x + d.dx, block.y + d.dy, block.z + d.dz),
        );
        if (neighbor) {
          if (neighbor === block.type) continue;
          if (isVoxelOccluder(neighbor)) continue;
        }
        if (!hasAtlasKey(getTextureKey(block.type, d.face))) continue;
        emitted += 1;
      }
      if (emitted > 0) visibleBlocks += 1;
      faces += emitted;
    }

    const packedBlockBytes = blocks.length * 8;
    console.log(
      [
        `${row.prompt.text.slice(0, 44)} | ${row.model.displayName}`,
        `  blocks ${blocks.length.toLocaleString()} (visible ${visibleBlocks.toLocaleString()})`,
        `  faces  ${faces.toLocaleString()} (${(faces / Math.max(1, blocks.length)).toFixed(2)} per block)`,
        `  packed blocks   ${mib(packedBlockBytes)}`,
        `  geometry now    ${mib(faces * BYTES_PER_FACE)}`,
        `  geometry before ${mib(faces * LEGACY_BYTES_PER_FACE)} (+ ${mib(faces * LEGACY_STAGING_BYTES_PER_FACE)} transient)`,
        `  geometry is ${(((faces * BYTES_PER_FACE) / packedBlockBytes) || 0).toFixed(0)}x the packed blocks`,
        `  faces per visible block ${(faces / Math.max(1, visibleBlocks)).toFixed(2)}`,
      ].join("\n"),
    );
    console.log("");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
