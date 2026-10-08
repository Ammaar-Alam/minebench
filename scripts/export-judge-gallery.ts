#!/usr/bin/env -S tsx
/**
 * Export visible Gallery builds in the judge-data snapshot layout so they can be rendered and scored.
 *
 * Gallery builds that were never copied into the Arena have no votes, which makes them a test set the judge
 * has never seen; Arena copies are left out. Writes prompts.jsonl (one row per Gallery prompt), builds.jsonl, and payloads/<buildId>.json.gz in the same
 * shape as `pnpm judge:export`, so `pnpm judge:render` works on the result unchanged.
 * Re-running reuses payloads already on disk while their JSON matches the artifact checksum.
 *
 * Usage:
 *   pnpm judge:gallery
 *   pnpm judge:gallery --out judge-data/gallery-2026-10-08
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gzipSync } from "node:zlib";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { isGzipChunk } from "../lib/arena/clientBuildResponse";
import { publicCandidateWhere, publicExampleWhere } from "../lib/gallery/service";
import { fetchStoredBuildBytes } from "../lib/storage/buildPayload";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

function writeJsonl(file: string, rows: unknown[]) {
  fs.writeFileSync(`${file}.tmp`, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  fs.renameSync(`${file}.tmp`, file);
}

async function sha256OfGzip(gz: Uint8Array): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(Readable.from([gz]), createGunzip(), async function* (source) {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
  });
  return { sha256: hash.digest("hex"), bytes };
}

async function main() {
  const prisma = new PrismaClient({ log: ["error"] });
  const exportedAt = new Date();
  const outDir = path.resolve(argValue("--out") ?? path.join("judge-data", `gallery-${exportedAt.toISOString().slice(0, 10)}`));
  fs.mkdirSync(path.join(outDir, "payloads"), { recursive: true });

  const allExamples = await prisma.galleryExample.findMany({
    where: { ...publicExampleWhere, candidate: publicCandidateWhere },
    orderBy: { customBuildId: "asc" },
    select: {
      candidate: { select: { id: true, promptText: true, upvoteCount: true, officialPromptId: true } },
      customBuild: {
        select: {
          id: true, createdAt: true, gridSize: true, palette: true, modelKey: true, modelProvider: true,
          modelDisplayName: true, blockCount: true,
          artifacts: { where: { kind: "build_json" }, select: { bucket: true, path: true, sourceBuildSha256: true } },
        },
      },
    },
  });

  // Arena copies of Gallery builds carry votes in the training snapshot, so they cannot be test builds
  const arenaCopyPaths = (
    await prisma.build.findMany({ where: { voxelStoragePath: { startsWith: "gallery/" } }, select: { voxelStoragePath: true } })
  ).map((b) => b.voxelStoragePath ?? "");
  const examples = allExamples.filter(({ customBuild }) => !arenaCopyPaths.some((p) => p.includes(`-${customBuild.id}-g`)));
  const arenaCopiesExcluded = allExamples.length - examples.length;

  const prompts = new Map<string, unknown>();
  const builds = [];
  for (const [i, { candidate, customBuild: build }] of examples.entries()) {
    prompts.set(candidate.id, {
      id: candidate.id,
      text: candidate.promptText,
      upvotes: candidate.upvoteCount,
      arenaPromptId: candidate.officialPromptId,
    });
    const artifact = build.artifacts[0];
    const payloadFile = path.join("payloads", `${build.id}.json.gz`);
    const absolute = path.join(outDir, payloadFile);
    let payload: { sha256: string; bytes: number } | null = null;
    let payloadError: string | null = null;
    try {
      if (!artifact) throw new Error("No build_json artifact");
      // checked on the decompressed JSON, since remote downloads may arrive already decoded
      if (fs.existsSync(absolute)) payload = await sha256OfGzip(fs.readFileSync(absolute)).catch(() => null);
      if (payload?.sha256 !== artifact.sourceBuildSha256) {
        const bytes = await fetchStoredBuildBytes({ bucket: artifact.bucket, path: artifact.path });
        const gz = isGzipChunk(bytes) ? bytes : gzipSync(bytes);
        payload = await sha256OfGzip(gz);
        if (payload.sha256 !== artifact.sourceBuildSha256) throw new Error("Stored payload does not match its artifact checksum");
        fs.writeFileSync(`${absolute}.tmp`, gz);
        fs.renameSync(`${absolute}.tmp`, absolute);
      }
    } catch (err) {
      payload = null;
      payloadError = err instanceof Error ? err.message : String(err);
    }
    builds.push({
      id: build.id,
      promptId: candidate.id,
      modelKey: build.modelKey,
      modelProvider: build.modelProvider,
      modelDisplayName: build.modelDisplayName,
      gridSize: build.gridSize,
      palette: build.palette,
      blockCount: Number(build.blockCount ?? 0),
      createdAt: build.createdAt,
      payloadFile: payloadError ? null : payloadFile,
      payloadBytes: payload?.bytes ?? null,
      payloadSha256: payload?.sha256 ?? null,
      payloadError,
    });
    if ((i + 1) % 50 === 0 || i + 1 === examples.length) console.log(`payloads ${i + 1}/${examples.length}`);
  }

  writeJsonl(path.join(outDir, "prompts.jsonl"), [...prompts.values()]);
  writeJsonl(path.join(outDir, "builds.jsonl"), builds);
  const failed = builds.filter((b) => b.payloadError);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify({ exportedAt, prompts: prompts.size, builds: builds.length, arenaCopiesExcluded, payloadFailures: failed.map((b) => ({ id: b.id, error: b.payloadError })) }, null, 2)}\n`,
  );
  console.log(`${prompts.size} prompts, ${builds.length} builds (${arenaCopiesExcluded} Arena copies excluded), ${failed.length} payload failures, wrote ${outDir}`);
  await prisma.$disconnect();
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
