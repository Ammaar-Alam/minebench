#!/usr/bin/env -S tsx

import "dotenv/config";
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { decodeBinaryArtifact } from "../lib/arena/binaryArtifact";
import { readStoredBuildSource, sha256Hex } from "../lib/custom-builds/artifacts";
import {
  deleteCustomBuildArtifact,
  downloadCustomBuildArtifactBytes,
  getCustomBuildArtifactDescriptor,
  getCustomBuildArtifactPath,
  uploadCustomBuildArtifact,
} from "../lib/custom-builds/storage";
import { buildGalleryPreviewPng } from "../lib/gallery/preview";
import { getSupabaseStorageConfig } from "../lib/storage/config";
import type { RenderableVoxelBuild } from "../lib/voxel/packedBlocks";

// redraws gallery previews stored before the png format and is safe to re-run
const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : undefined;
const descriptor = getCustomBuildArtifactDescriptor("preview_image");
// keyed by storage project because alpha shares bucket names and paths with production
const STORAGE_PROJECT = new URL(getSupabaseStorageConfig().url).hostname;
// objects to remove once nothing references them, kept until their delete succeeds
const PENDING_CLEANUP_PATH = `gallery-preview-cleanup-${STORAGE_PROJECT}.json`;
// one run at a time per project, since overlapping runs race on uploads and the journal
const LOCK_PATH = `gallery-preview-backfill-${STORAGE_PROJECT}.lock`;

type StoredObject = { bucket: string; path: string };

function readPendingCleanup(): StoredObject[] {
  return fs.existsSync(PENDING_CLEANUP_PATH) ? JSON.parse(fs.readFileSync(PENDING_CLEANUP_PATH, "utf8")) : [];
}

function writePendingCleanup(objects: StoredObject[]) {
  if (objects.length > 0) fs.writeFileSync(PENDING_CLEANUP_PATH, `${JSON.stringify(objects, null, 2)}\n`);
  else fs.rmSync(PENDING_CLEANUP_PATH, { force: true });
}

// returns the objects that still need another attempt
async function cleanUp(prisma: PrismaClient, objects: StoredObject[]): Promise<StoredObject[]> {
  const remaining: StoredObject[] = [];
  for (const object of objects) {
    try {
      if (await prisma.customBuildArtifact.count({ where: object }) === 0) await deleteCustomBuildArtifact(object);
    } catch (error) {
      console.error(`delete of ${object.path} failed:`, error instanceof Error ? error.message : error);
      remaining.push(object);
    }
  }
  return remaining;
}

async function loadPreviewSource(prisma: PrismaClient, customBuildId: string): Promise<RenderableVoxelBuild> {
  const artifacts = await prisma.customBuildArtifact.findMany({
    where: { customBuildId, kind: { in: ["viewer_world", "preview_mbv4", "build_json"] } },
    orderBy: { createdAt: "desc" },
  });
  // worlds draw from their shared sample like the generate job
  if (artifacts.some((artifact) => artifact.kind === "viewer_world")) {
    const sample = artifacts.find((artifact) => artifact.kind === "preview_mbv4");
    if (!sample) throw new Error("world preview sample is missing");
    const stored = await downloadCustomBuildArtifactBytes(sample);
    // storage may already have decoded the gzip transfer encoding
    const { blocks } = decodeBinaryArtifact(stored[0] === 0x1f && stored[1] === 0x8b ? gunzipSync(stored) : stored);
    return { version: "1.0", blocks: [], packed: blocks };
  }
  const source = artifacts.find((artifact) => artifact.kind === "build_json");
  if (!source) throw new Error("canonical build is missing");
  return readStoredBuildSource(source, {});
}

async function main() {
  let lock: number;
  try {
    lock = fs.openSync(LOCK_PATH, "wx");
  } catch {
    throw new Error(`${LOCK_PATH} exists, another backfill is running or the last one crashed and left it behind`);
  }
  const prisma = new PrismaClient();
  try {
    let pendingCleanup = readPendingCleanup();
    if (!dryRun && pendingCleanup.length > 0) {
      console.log(`retrying ${pendingCleanup.length} pending deletes`);
      pendingCleanup = await cleanUp(prisma, pendingCleanup);
      writePendingCleanup(pendingCleanup);
    }
    const settle = async (object: StoredObject) => {
      pendingCleanup.push(object);
      writePendingCleanup(pendingCleanup);
      pendingCleanup = [...pendingCleanup.slice(0, -1), ...(await cleanUp(prisma, [object]))];
      writePendingCleanup(pendingCleanup);
    };
    const rows = await prisma.customBuildArtifact.findMany({
      where: {
        kind: "preview_image",
        contentType: { not: descriptor.contentType },
        customBuild: { removedAt: null, status: "succeeded" },
      },
      include: { customBuild: { select: { publicId: true } } },
      // newest first so the builds people see first are redrawn first
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    console.log(`${rows.length} previews to redraw${dryRun ? " (dry run)" : ""}`);

    let redrawn = 0;
    let failed = 0;
    for (const [index, row] of rows.entries()) {
      const label = `[${index + 1}/${rows.length}] ${row.customBuild.publicId}`;
      try {
        const started = performance.now();
        const bytes = await buildGalleryPreviewPng(await loadPreviewSource(prisma, row.customBuildId));
        const sha256 = sha256Hex(bytes);
        const path = getCustomBuildArtifactPath({
          publicId: row.customBuild.publicId,
          kind: "preview_image",
          sha256,
          sourceBuildSha256: row.sourceBuildSha256 ?? undefined,
        });
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        if (dryRun) {
          console.log(`${label} ${bytes.byteLength} bytes in ${seconds}s`);
          redrawn += 1;
          continue;
        }

        await uploadCustomBuildArtifact({ bucket: row.bucket, path, bytes, contentType: descriptor.contentType });
        let recorded: boolean;
        try {
          recorded = await prisma.$transaction(async (tx) => {
            // claims only the version this run read so overlapping runs adjust the total once
            const claimed = await tx.customBuildArtifact.updateMany({
              where: { id: row.id, path: row.path, customBuild: { removedAt: null } },
              data: {
                format: descriptor.format,
                contentType: descriptor.contentType,
                fileName: `${row.customBuild.publicId}-preview.png`,
                path,
                sha256,
                encoding: "identity",
                byteSize: bytes.byteLength,
                compressedByteSize: null,
                storedByteSize: bytes.byteLength,
              },
            });
            if (claimed.count !== 1) return false;
            await tx.customBuild.update({
              where: { id: row.customBuildId },
              data: { storedByteSize: { increment: BigInt(bytes.byteLength) - row.storedByteSize } },
            });
            return true;
          });
        } catch (error) {
          await settle({ bucket: row.bucket, path });
          throw error;
        }
        if (!recorded) {
          await settle({ bucket: row.bucket, path });
          console.log(`${label} skipped, already redrawn or removed`);
          continue;
        }
        await settle({ bucket: row.bucket, path: row.path });
        console.log(`${label} ${bytes.byteLength} bytes in ${seconds}s`);
        redrawn += 1;
      } catch (error) {
        failed += 1;
        console.error(`${label} failed:`, error instanceof Error ? error.message : error);
      }
    }
    console.log(`redrawn ${redrawn}, failed ${failed}`);
    if (pendingCleanup.length > 0) console.log(`${pendingCleanup.length} deletes pending in ${PENDING_CLEANUP_PATH}, run again to retry`);
    if (failed > 0 || pendingCleanup.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    fs.closeSync(lock);
    fs.rmSync(LOCK_PATH, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
