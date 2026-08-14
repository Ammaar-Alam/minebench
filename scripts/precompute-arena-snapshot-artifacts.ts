#!/usr/bin/env -S tsx

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { gzipSync } from "node:zlib";
import {
  getPreparedArenaBuildMetadataUpdate,
  pickBuildVariant,
  prepareArenaBuild,
} from "../lib/arena/buildArtifacts";
import { ensureArenaBuildSnapshotArtifacts } from "../lib/arena/buildSnapshotArtifacts";
import type { ArenaBuildVariant } from "../lib/arena/types";

import {
  arenaMaintenanceWhere,
  describeScope,
  parseArenaMaintenanceArgs,
  type ArenaMaintenanceArgs,
} from "./arenaMaintenanceCli";
import {
  ARTIFACT_STATUS_BUILD_SELECT,
  getArenaBuildArtifactStatuses,
} from "../lib/arena/artifactCoverage";

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
    },
  });

  if (!payloadRow) {
    throw new Error(`Build ${row.id} not found`);
  }

  return payloadRow;
}

function estimateSnapshotArtifactBytes(
  prepared: Awaited<ReturnType<typeof prepareArenaBuild>>,
  variant: ArenaBuildVariant,
) {
  const payload = {
    buildId: prepared.buildId,
    variant,
    checksum: prepared.checksum,
    serverValidated: true,
    buildLoadHints: prepared.hints,
    voxelBuild: pickBuildVariant(prepared, variant),
  };
  const raw = Buffer.from(JSON.stringify(payload));
  return {
    rawBytes: raw.length,
    gzipBytes: gzipSync(raw).length,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const prisma = new PrismaClient();

  console.log("Precomputing arena snapshot artifacts");
  console.log(`- dry run: ${opts.dryRun ? "yes" : "no"}`);
  console.log(`- limit: ${opts.all ? "all" : opts.limit}`);
  for (const line of describeScope(opts)) console.log(line);
  console.log("");

  try {
    let rows = await prisma.build.findMany({
      where: arenaMaintenanceWhere(opts),
      orderBy: { createdAt: "desc" },
      // with --missing-only the limit is applied after status discovery, so a
      // complete newest prefix cannot hide older builds that still need work
      ...(opts.all || opts.missingOnly ? {} : { take: opts.limit }),
      select: {
        ...ARTIFACT_STATUS_BUILD_SELECT,
        gridSize: true,
        palette: true,
        voxelStorageBucket: true,
        voxelStoragePath: true,
        voxelStorageEncoding: true,
      },
    });

    if (opts.missingOnly) {
      const statuses = await getArenaBuildArtifactStatuses(rows);
      const needsWork = new Set(
        statuses
          .filter(
            (status) =>
              status.needsSnapshotCompute ||
              status.missing.some((requirement) => requirement.kind === "snapshot"),
          )
          .map((status) => status.buildId),
      );
      const skipped = rows.length - needsWork.size;
      rows = rows.filter((row) => needsWork.has(row.id));
      if (!opts.all && rows.length > opts.limit) rows = rows.slice(0, opts.limit);
      if (skipped > 0) console.log(`Skipping ${skipped} build(s) with snapshot artifacts present.`);
    }

    if (rows.length === 0) {
      console.log("No matching builds found.");
      return;
    }

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows as BuildRow[]) {
      try {
        const payloadRow = await loadBuildPayloadRow(prisma, row);
        const prepared = await prepareArenaBuild(payloadRow);

        const previewNeeded = prepared.previewBuild.blocks.length < prepared.fullBuild.blocks.length;
        const fullNeeded =
          prepared.hints.deliveryClass === "snapshot" || prepared.hints.deliveryClass === "inline";
        const planned = Number(previewNeeded) + Number(fullNeeded);

        if (opts.dryRun) {
          if (planned === 0) {
            skipped += 1;
            console.log(`- skip ${row.id}: no useful snapshot artifact variants`);
            continue;
          }
          const variants: ArenaBuildVariant[] = [];
          if (previewNeeded) variants.push("preview");
          if (fullNeeded) variants.push("full");
          const byteSummary = variants
            .map((variant) => {
              const size = estimateSnapshotArtifactBytes(prepared, variant);
              return `${variant}=${(size.rawBytes / (1024 * 1024)).toFixed(2)}MB raw/${(size.gzipBytes / (1024 * 1024)).toFixed(2)}MB gzip`;
            })
            .join(" ");
          console.log(
            `- dry-run ${row.id}: preview=${previewNeeded ? "yes" : "no"} full=${fullNeeded ? "yes" : "no"} ${byteSummary}`,
          );
          uploaded += planned;
          continue;
        }

        const result = await ensureArenaBuildSnapshotArtifacts(prepared);
        // Record what now exists. Coverage treats a marker that disagrees with
        // voxelSha256 as missing, and the missing-only metadata backfill skips
        // rows whose checksum and hints are already set, so without this a
        // stale marker survives its own recomputation and the build stays in
        // missingBuildIds forever. Writing on the skipped path too clears a
        // stale marker for builds that need no snapshot at all.
        //
        // Guarded on the checksum observed when the row was loaded: an
        // import-build overwrite can land while this build is being prepared,
        // and an unconditional write would restore the previous checksum,
        // hints, and snapshot over the newly stored payload, leaving a row that
        // coverage could approve against the superseded artifact.
        const marked = await prisma.build.updateMany({
          where: { id: row.id, voxelSha256: row.voxelSha256 },
          data: getPreparedArenaBuildMetadataUpdate(prepared),
        });
        if (marked.count === 0) {
          skipped += 1;
          console.log(
            `- skip ${row.id}: payload changed during maintenance, leaving it for the next pass`,
          );
          continue;
        }

        if (result.skipped) {
          skipped += 1;
          console.log(`- skip ${row.id}: snapshot artifacts not needed`);
          continue;
        }
        uploaded += result.uploaded;
        console.log(`- uploaded ${row.id}: variants=${result.uploaded}`);
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.log(`- failed ${row.id}: ${message}`);
      }
    }

    console.log("");
    console.log(`Done. uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
