#!/usr/bin/env -S tsx

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { gzipSync } from "node:zlib";
import {
  getPreparedArenaBuildCoreMetadataUpdate,
  pickBuildVariant,
  prepareArenaBuild,
} from "../lib/arena/buildArtifacts";
import { encodeBinaryArtifact } from "../lib/arena/binaryArtifact";
import { packVoxelBlocks } from "../lib/voxel/packedBlocks";
import { createVoxelMeshFacts, encodeVoxelMeshFacts } from "../lib/voxel/meshFacts";
import {
  ensureArenaBuildSnapshotArtifacts,
  expectedSnapshotArtifactTargets,
  type ArenaSnapshotArtifactTarget,
} from "../lib/arena/buildSnapshotArtifacts";

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
  target: ArenaSnapshotArtifactTarget,
) {
  const voxelBuild = pickBuildVariant(prepared, target.variant);
  const envelope = {
    buildId: prepared.buildId,
    variant: target.variant,
    checksum: prepared.checksum,
    serverValidated: true,
    buildLoadHints: prepared.hints,
  };
  const raw =
    target.format === "mesh-facts"
      ? Buffer.from(
          encodeVoxelMeshFacts(createVoxelMeshFacts(packVoxelBlocks(voxelBuild.blocks))),
        )
      : target.format === "binary"
      ? Buffer.from(
          encodeBinaryArtifact(
            { ...envelope, version: voxelBuild.version },
            voxelBuild.blocks,
            prepared.checksum,
          ),
        )
      : Buffer.from(JSON.stringify({ ...envelope, voxelBuild }));
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
              // a build whose JSON object is present but whose binary one is not
              // still needs work, or the faster read path never gets an object
              status.missing.some(
                (requirement) =>
                  requirement.kind === "snapshot" ||
                  requirement.kind === "snapshot-binary" ||
                  requirement.kind === "snapshot-mesh-facts",
              ),
          )
          .map((status) => status.buildId),
      );
      const skipped = rows.length - needsWork.size;
      rows = rows.filter((row) => needsWork.has(row.id));
      if (!opts.all && rows.length > opts.limit) rows = rows.slice(0, opts.limit);
      if (skipped > 0) console.log(`Skipping ${skipped} build(s) with all snapshot artifacts present.`);
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

        const targets = expectedSnapshotArtifactTargets(prepared);

        if (opts.dryRun) {
          if (targets.length === 0) {
            skipped += 1;
            console.log(`- skip ${row.id}: no useful snapshot artifact variants`);
            continue;
          }
          const byteSummary = targets
            .map((target) => {
              const size = estimateSnapshotArtifactBytes(prepared, target);
              return (
                `${target.variant}/${target.format}=` +
                `${(size.rawBytes / (1024 * 1024)).toFixed(2)}MB raw/` +
                `${(size.gzipBytes / (1024 * 1024)).toFixed(2)}MB gzip`
              );
            })
            .join(" ");
          console.log(`- dry-run ${row.id}: ${byteSummary}`);
          uploaded += targets.length;
          continue;
        }

        const result = await ensureArenaBuildSnapshotArtifacts(prepared);
        // Storage identity protects checksum-less rows from concurrent overwrites
        const marked = await prisma.build.updateMany({
          where: prepared.payloadIdentity,
          data: getPreparedArenaBuildCoreMetadataUpdate(prepared),
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
