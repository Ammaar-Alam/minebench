#!/usr/bin/env -S tsx
/**
 * Export visible Gallery builds in the judge-data snapshot layout so they can be rendered and scored.
 *
 * Gallery builds have no Arena votes, which makes them a test set the judge has never seen. Writes
 * prompts.jsonl (one row per Gallery prompt), builds.jsonl, and payloads/<buildId>.json.gz in the same
 * shape as `pnpm judge:export`, so `pnpm judge:render` works on the result unchanged.
 * Re-running reuses payloads already on disk while they match the artifact checksum.
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
import { createGunzip } from "node:zlib";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
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

  const visible = { removedAt: null, adminHiddenAt: null };
  const examples = await prisma.galleryExample.findMany({
    where: { ...visible, candidate: visible, customBuild: { status: "succeeded", removedAt: null } },
    orderBy: { customBuildId: "asc" },
    select: {
      candidate: { select: { id: true, promptText: true, upvoteCount: true, officialPromptId: true } },
      customBuild: {
        select: {
          id: true, createdAt: true, gridSize: true, palette: true, modelKey: true, modelProvider: true,
          modelDisplayName: true, blockCount: true,
          artifacts: { where: { kind: "build_json" }, select: { bucket: true, path: true, sha256: true } },
        },
      },
    },
  });

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
      if (fs.existsSync(absolute)) {
        const cached = await sha256OfGzip(fs.readFileSync(absolute));
        if (cached.sha256 === artifact.sha256) payload = cached;
      }
      if (!payload) {
        const gz = await fetchStoredBuildBytes({ bucket: artifact.bucket, path: artifact.path });
        fs.writeFileSync(`${absolute}.tmp`, gz);
        fs.renameSync(`${absolute}.tmp`, absolute);
        payload = await sha256OfGzip(gz);
      }
    } catch (err) {
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
    `${JSON.stringify({ exportedAt, prompts: prompts.size, builds: builds.length, payloadFailures: failed.map((b) => ({ id: b.id, error: b.payloadError })) }, null, 2)}\n`,
  );
  console.log(`${prompts.size} prompts, ${builds.length} builds, ${failed.length} payload failures, wrote ${outDir}`);
  await prisma.$disconnect();
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
