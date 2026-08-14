#!/usr/bin/env -S tsx

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  getPreparedArenaBuildMetadataUpdate,
  parsePersistedArenaBuildMetadata,
  prepareArenaBuild,
} from "../lib/arena/buildArtifacts";

import {
  arenaMaintenanceWhere,
  describeScope,
  parseArenaMaintenanceArgs,
  type ArenaMaintenanceArgs,
} from "./arenaMaintenanceCli";

type Args = ArenaMaintenanceArgs;

type BuildRow = {
  id: string;
  gridSize: number;
  palette: string;
  blockCount: number;
  voxelByteSize: number | null;
  voxelCompressedByteSize: number | null;
  voxelSha256: string | null;
  voxelStorageBucket: string | null;
  voxelStoragePath: string | null;
  voxelStorageEncoding: string | null;
  arenaBuildHints: unknown | null;
};

type BuildPayloadRow = BuildRow & {
  voxelData: unknown | null;
};

function parseArgs(argv: string[]): Args {
  return parseArenaMaintenanceArgs(argv.slice(2));
}

async function loadBuildPayloadRow(
  prisma: PrismaClient,
  row: BuildRow,
): Promise<BuildPayloadRow> {
  if (row.voxelStorageBucket && row.voxelStoragePath) {
    return {
      ...row,
      voxelData: null,
    };
  }

  const payloadRow = await prisma.build.findUnique({
    where: { id: row.id },
    select: {
      id: true,
      gridSize: true,
      palette: true,
      blockCount: true,
      voxelByteSize: true,
      voxelCompressedByteSize: true,
      voxelSha256: true,
      voxelData: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
      voxelStorageEncoding: true,
      arenaBuildHints: true,
    },
  });

  if (!payloadRow) {
    throw new Error(`Build ${row.id} not found`);
  }

  return payloadRow;
}

async function main() {
  const opts = parseArgs(process.argv);
  const prisma = new PrismaClient();

  console.log("Backfilling arena build metadata");
  console.log(`- dry run: ${opts.dryRun ? "yes" : "no"}`);
  console.log(`- limit: ${opts.all ? "all" : opts.limit}`);
  for (const line of describeScope(opts)) console.log(line);
  console.log("");

  try {
    const cohortWhere = arenaMaintenanceWhere(opts);
    let rows = await prisma.build.findMany({
      where: cohortWhere,
      orderBy: { createdAt: "desc" },
      take: opts.missingOnly || opts.all ? undefined : opts.limit,
      select: {
        id: true,
        gridSize: true,
        palette: true,
        blockCount: true,
        voxelByteSize: true,
        voxelCompressedByteSize: true,
        voxelSha256: true,
        voxelStorageBucket: true,
        voxelStoragePath: true,
        voxelStorageEncoding: true,
        arenaBuildHints: true,
      },
    });

    if (opts.missingOnly) {
      // JSON filters cannot identify malformed non-null hints
      rows = rows.filter((row) => {
        return !parsePersistedArenaBuildMetadata(row).complete;
      });
      if (!opts.all && rows.length > opts.limit) rows = rows.slice(0, opts.limit);
    }

    if (rows.length === 0) {
      console.log("No matching builds found.");
      return;
    }

    let updated = 0;
    let failed = 0;

    for (const row of rows as BuildRow[]) {
      try {
        const payloadRow = await loadBuildPayloadRow(prisma, row);
        const prepared = await prepareArenaBuild(payloadRow);
        const data = getPreparedArenaBuildMetadataUpdate(prepared);

        if (opts.dryRun) {
          console.log(
            `- dry-run ${row.id}: checksum=${String(data.voxelSha256 ?? "null")} hints=${JSON.stringify(data.arenaBuildHints)}`,
          );
          updated += 1;
          continue;
        }

        const result = await prisma.build.updateMany({
          where: prepared.payloadIdentity,
          data,
        });
        if (result.count === 0) {
          console.log(`- skip ${row.id}: payload changed during maintenance`);
          continue;
        }
        updated += 1;
        console.log(`- updated ${row.id}`);
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.log(`- failed ${row.id}: ${message}`);
      }
    }

    console.log("");
    console.log(`Done. updated=${updated} failed=${failed}`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
