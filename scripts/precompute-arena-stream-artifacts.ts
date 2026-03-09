#!/usr/bin/env npx tsx

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { estimateArenaBuildBytes, getArenaArtifactMinBytes } from "../lib/arena/buildDeliveryPolicy";
import type { ArenaBuildStreamEvent, ArenaBuildVariant } from "../lib/arena/types";
import { pickBuildVariant, prepareArenaBuild } from "../lib/arena/buildArtifacts";
import {
  encodeArenaBuildStreamEvent,
  iterateArenaBuildStreamEvents,
  uploadArenaBuildStreamArtifact,
} from "../lib/arena/buildStream";

type Args = {
  dryRun: boolean;
  limit: number;
  all: boolean;
  minBytes: number;
  variants: ArenaBuildVariant[];
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
  const minBytesIndex = args.indexOf("--min-bytes");
  const parsedMinBytes =
    minBytesIndex >= 0 ? Number.parseInt(args[minBytesIndex + 1] ?? "", 10) : NaN;
  const envMinBytes = Number.parseInt(process.env.ARENA_ARTIFACT_MIN_BYTES ?? "", 10);
  const defaultMinBytes =
    Number.isFinite(envMinBytes) && envMinBytes > 0 ? envMinBytes : getArenaArtifactMinBytes();
  const minBytes =
    Number.isFinite(parsedMinBytes) && parsedMinBytes > 0 ? parsedMinBytes : defaultMinBytes;

  const variantIndex = args.indexOf("--variant");
  const variantRaw = (variantIndex >= 0 ? args[variantIndex + 1] : "both")?.trim().toLowerCase() ?? "both";
  const variants: ArenaBuildVariant[] =
    variantRaw === "full"
      ? ["full"]
      : variantRaw === "preview"
        ? ["preview"]
        : ["full", "preview"];

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
    minBytes,
    variants,
    buildIds,
  };
}

function chunkBytes(events: Iterable<ArenaBuildStreamEvent>) {
  const encoded: Uint8Array[] = [];
  let total = 0;
  for (const event of events) {
    const bytes = encodeArenaBuildStreamEvent(event);
    encoded.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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

async function main() {
  const opts = parseArgs(process.argv);
  const prisma = new PrismaClient();

  console.log("Precomputing arena stream artifacts");
  console.log(`- dry run: ${opts.dryRun ? "yes" : "no"}`);
  console.log(`- variants: ${opts.variants.join(", ")}`);
  console.log(`- limit: ${opts.all ? "all" : opts.limit}`);
  console.log(`- min bytes: ${opts.minBytes.toLocaleString()} (${(opts.minBytes / (1024 * 1024)).toFixed(2)} MB)`);
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
      },
    });

    if (rows.length === 0) {
      console.log("No matching builds found.");
      return;
    }

    let uploaded = 0;
    let skippedSmall = 0;
    let skippedUnknown = 0;
    let skippedChecksum = 0;
    let failed = 0;
    let eligible = 0;

    for (const row of rows as BuildRow[]) {
      try {
        const estimatedBytes = estimateArenaBuildBytes({
          blockCount: row.blockCount,
          voxelByteSize: row.voxelByteSize,
          voxelCompressedByteSize: row.voxelCompressedByteSize,
        });
        let prepared: Awaited<ReturnType<typeof prepareArenaBuild>> | null = null;
        let payloadRow: BuildPayloadRow | null = null;
        let effectiveBytes = estimatedBytes;
        if (effectiveBytes == null) {
          payloadRow = await loadBuildPayloadRow(prisma, row);
          prepared = await prepareArenaBuild(payloadRow);
          effectiveBytes = prepared.hints.fullEstimatedBytes;
        }
        if (effectiveBytes == null) {
          payloadRow = payloadRow ?? (await loadBuildPayloadRow(prisma, row));
          if (payloadRow.voxelData != null) {
            effectiveBytes = Buffer.byteLength(JSON.stringify(payloadRow.voxelData));
          }
        }
        if (effectiveBytes == null) {
          skippedUnknown += 1;
          console.log(`- skip ${row.id}: unknown payload byte size`);
          continue;
        }

        if (effectiveBytes < opts.minBytes) {
          skippedSmall += 1;
          console.log(
            `- skip ${row.id}: estimated ${effectiveBytes.toLocaleString()} bytes (< ${opts.minBytes.toLocaleString()})`,
          );
          continue;
        }

        if (!prepared) {
          payloadRow = payloadRow ?? (await loadBuildPayloadRow(prisma, row));
          prepared = await prepareArenaBuild(payloadRow);
        }
        if (!prepared.checksum) {
          skippedChecksum += 1;
          console.log(`- skip ${row.id}: missing checksum`);
          continue;
        }
        eligible += 1;

        for (const variant of opts.variants) {
          const variantBuild = pickBuildVariant(prepared, variant);
          const bytes = chunkBytes(
            iterateArenaBuildStreamEvents({
              buildId: row.id,
              variant,
              checksum: prepared.checksum,
              build: variantBuild,
              buildLoadHints: prepared.hints,
              source: "artifact",
              serverValidated: true,
              includePad: true,
              durationMs: 0,
            }),
          );

          if (opts.dryRun) {
            console.log(
              `- dry-run ${row.id} (${variant}): source ${(effectiveBytes / (1024 * 1024)).toFixed(2)} MB, stream ${(bytes.length / (1024 * 1024)).toFixed(2)} MB`,
            );
            continue;
          }

          await uploadArenaBuildStreamArtifact(row.id, variant, prepared.checksum, bytes);
          uploaded += 1;
          console.log(
            `- uploaded ${row.id} (${variant}): source ${(effectiveBytes / (1024 * 1024)).toFixed(2)} MB, stream ${(bytes.length / (1024 * 1024)).toFixed(2)} MB`,
          );
        }
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.log(`- failed ${row.id}: ${message}`);
      }
    }

    console.log("");
    console.log(
      `Done. eligible=${eligible} uploaded=${uploaded} skippedSmall=${skippedSmall} skippedUnknown=${skippedUnknown} skippedChecksum=${skippedChecksum} failed=${failed}`,
    );
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
