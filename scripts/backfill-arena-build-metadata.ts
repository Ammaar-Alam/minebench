#!/usr/bin/env npx tsx

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  getPreparedArenaBuildMetadataUpdate,
  prepareArenaBuild,
} from "../lib/arena/buildArtifacts";

type Args = {
  dryRun: boolean;
  limit: number;
  all: boolean;
  buildIds: string[];
};

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
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");

  const limitIndex = args.indexOf("--limit");
  const parsedLimit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 250;

  const buildIds: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--build") continue;
    const next = args[i + 1]?.trim();
    if (next) buildIds.push(next);
  }

  return {
    dryRun,
    limit,
    all,
    buildIds,
  };
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
  if (opts.buildIds.length > 0) {
    console.log(`- build filter: ${opts.buildIds.join(", ")}`);
  }
  console.log("");

  try {
    const where =
      opts.buildIds.length > 0
        ? { id: { in: opts.buildIds } }
        : {
            gridSize: 256,
            palette: "simple",
            mode: "precise",
            model: { enabled: true, isBaseline: false },
            prompt: { active: true },
          };

    const rows = await prisma.build.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: opts.all ? undefined : opts.limit,
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

        await prisma.build.update({
          where: { id: row.id },
          data,
        });
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
