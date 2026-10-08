#!/usr/bin/env -S tsx
/**
 * Export a snapshot of public Arena data for judge training.
 *
 * Writes prompts/models/builds/votes as JSONL plus one gzipped payload per build.
 * Private evaluation data (stealth models, their builds, stealth matchups) is excluded.
 * Votes keep raw session and account ids and are marked when an active admin vote
 * block covers their session, account, or network. Output stays local and git-ignored.
 * Re-running reuses stored payloads already on disk while they match the recorded checksum.
 *
 * Usage:
 *   pnpm judge:export
 *   pnpm judge:export --out judge-data/2026-10-07
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gzipSync } from "node:zlib";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { fetchStoredBuildBytes } from "../lib/storage/buildPayload";
import { hashVoteSession } from "../lib/voteBlock";

const VOTE_PAGE_SIZE = 20_000;
const DOWNLOAD_CONCURRENCY = 6;

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

function writeJsonl(file: string, rows: Iterable<unknown>) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  for (const row of rows) fs.writeSync(fd, `${JSON.stringify(row)}\n`);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

// stored payloads can exceed the max string length so hash the raw json bytes as a stream
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

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

async function main() {
  const prisma = new PrismaClient({ log: ["error"] });
  const snapshotAt = new Date();
  const outDir = path.resolve(argValue("--out") ?? path.join("judge-data", snapshotAt.toISOString().slice(0, 10)));
  const payloadDir = path.join(outDir, "payloads");
  fs.mkdirSync(payloadDir, { recursive: true });

  // same matching as the admin vote review: session hash, account, or a network seen on the session
  const blocks = await prisma.galleryVoteBlock.findMany({
    where: { reversedAt: null },
    select: { userId: true, sessionHash: true, ipHmac: true },
  });
  const blockedUsers = new Set(blocks.flatMap((b) => (b.userId ? [b.userId] : [])));
  const blockedSessionHashes = new Set(blocks.flatMap((b) => (b.sessionHash ? [b.sessionHash] : [])));
  const blockedIps = blocks.flatMap((b) => (b.ipHmac ? [b.ipHmac] : []));
  const blockedIpSessions = new Set(
    blockedIps.length
      ? (await prisma.publicSessionActivity.findMany({
          where: { ipHmac: { in: blockedIps } },
          select: { sessionId: true },
        })).map((s) => s.sessionId)
      : [],
  );
  const restrictedBySession = new Map<string, boolean>();
  const isRestricted = (sessionId: string, userId: string | null) => {
    if (userId && blockedUsers.has(userId)) return true;
    let restricted = restrictedBySession.get(sessionId);
    if (restricted === undefined) {
      restricted = blockedIpSessions.has(sessionId) || blockedSessionHashes.has(hashVoteSession(sessionId)!);
      restrictedBySession.set(sessionId, restricted);
    }
    return restricted;
  };

  const stealthModelIds = new Set(
    (await prisma.stealthVariant.findMany({ select: { modelId: true } })).map((v) => v.modelId),
  );
  const publicModel = { id: { notIn: [...stealthModelIds] } };

  const prompts = await prisma.prompt.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, text: true, gridSize: true, palette: true, active: true, createdAt: true },
  });
  const models = await prisma.model.findMany({
    where: publicModel,
    orderBy: { key: "asc" },
    select: { id: true, key: true, provider: true, modelId: true, displayName: true, isBaseline: true, enabled: true },
  });
  const builds = await prisma.build.findMany({
    where: { model: publicModel },
    orderBy: { id: "asc" },
    select: {
      id: true, promptId: true, modelId: true, gridSize: true, palette: true, mode: true, active: true,
      createdAt: true, blockCount: true, generationTimeMs: true, voxelSha256: true, voxelData: true,
      voxelStorageBucket: true, voxelStoragePath: true,
    },
  });

  // storage objects can be replaced in place, so keep their timestamps next to each build's first vote
  const storageRows = await prisma.$queryRaw<{ bucket_id: string; name: string; updated_at: Date | null }[]>`
    SELECT bucket_id, name, updated_at FROM storage.objects
    WHERE bucket_id IN (SELECT DISTINCT "voxelStorageBucket" FROM "Build" WHERE "voxelStorageBucket" IS NOT NULL)`;
  const storageUpdatedAt = new Map(storageRows.map((r) => [`${r.bucket_id}/${r.name}`, r.updated_at]));
  const firstVoteRows = await prisma.$queryRaw<{ build_id: string; first_vote_at: Date }[]>`
    SELECT b.build_id, min(v."createdAt") AS first_vote_at
    FROM "Vote" v
    JOIN "Matchup" m ON m.id = v."matchupId"
    CROSS JOIN LATERAL (VALUES (m."buildAId"), (m."buildBId")) AS b(build_id)
    WHERE m."stealthVariantId" IS NULL AND v."createdAt" <= ${snapshotAt}
    GROUP BY b.build_id`;
  const firstVoteAt = new Map(firstVoteRows.map((r) => [r.build_id, r.first_vote_at]));

  let done = 0;
  const buildRows = await mapPool(builds, DOWNLOAD_CONCURRENCY, async (build) => {
    const payloadFile = path.join("payloads", `${build.id}.json.gz`);
    const absolute = path.join(outDir, payloadFile);
    const source = build.voxelData != null ? "inline" : "storage";
    let payload: { sha256: string; bytes: number } | null = null;
    let payloadError: string | null = null;
    try {
      let gz: Uint8Array | null = null;
      // reuse a stored payload only while it matches the build's recorded checksum; imports can overwrite a build in place
      if (build.voxelData == null && build.voxelSha256 && fs.existsSync(absolute)) {
        const cached = fs.readFileSync(absolute);
        const hashed = await sha256OfGzip(cached);
        if (hashed.sha256 === build.voxelSha256) {
          gz = cached;
          payload = hashed;
        }
      }
      if (!gz) {
        if (build.voxelData != null) {
          gz = gzipSync(JSON.stringify(build.voxelData));
        } else {
          if (!build.voxelStorageBucket || !build.voxelStoragePath) throw new Error("No payload pointer");
          gz = await fetchStoredBuildBytes({ bucket: build.voxelStorageBucket, path: build.voxelStoragePath });
          if (gz[0] !== 0x1f || gz[1] !== 0x8b) gz = gzipSync(gz);
        }
        fs.writeFileSync(`${absolute}.tmp`, gz);
        fs.renameSync(`${absolute}.tmp`, absolute);
        payload = await sha256OfGzip(gz);
      }
    } catch (err) {
      payloadError = err instanceof Error ? err.message : String(err);
    }
    done += 1;
    if (done % 100 === 0 || done === builds.length) console.log(`payloads ${done}/${builds.length}`);

    const storageKey = build.voxelStorageBucket && build.voxelStoragePath
      ? `${build.voxelStorageBucket}/${build.voxelStoragePath}`
      : null;
    return {
      id: build.id,
      promptId: build.promptId,
      modelId: build.modelId,
      gridSize: build.gridSize,
      palette: build.palette,
      mode: build.mode,
      active: build.active,
      createdAt: build.createdAt,
      blockCount: build.blockCount,
      generationTimeMs: build.generationTimeMs,
      payloadFile: payloadError ? null : payloadFile,
      payloadSource: source,
      payloadBytes: payload?.bytes ?? null,
      payloadSha256: payload?.sha256 ?? null,
      // inline payloads come back from jsonb with reordered keys so only storage hashes are comparable
      recordedSha256: build.voxelSha256,
      storageUpdatedAt: storageKey ? (storageUpdatedAt.get(storageKey) ?? null) : null,
      firstVoteAt: firstVoteAt.get(build.id) ?? null,
      payloadError,
    };
  });

  const voteWhere = { createdAt: { lte: snapshotAt }, matchup: { stealthVariantId: null } };
  const excludedPrivateVotes = await prisma.vote.count({
    where: { createdAt: { lte: snapshotAt }, matchup: { stealthVariantId: { not: null } } },
  });
  const voteRows: ({ restricted: boolean } & Record<string, unknown>)[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await prisma.vote.findMany({
      where: voteWhere,
      orderBy: { id: "asc" },
      take: VOTE_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true, createdAt: true, choice: true, sessionId: true, userId: true,
        matchup: {
          select: {
            id: true, createdAt: true, promptId: true, buildAId: true, buildBId: true,
            modelAId: true, modelBId: true, samplingLane: true, samplingReason: true,
          },
        },
      },
    });
    for (const v of page) {
      voteRows.push({
        id: v.id,
        createdAt: v.createdAt,
        choice: v.choice,
        sessionId: v.sessionId,
        userId: v.userId,
        restricted: isRestricted(v.sessionId, v.userId),
        matchupId: v.matchup.id,
        matchupCreatedAt: v.matchup.createdAt,
        promptId: v.matchup.promptId,
        buildAId: v.matchup.buildAId,
        buildBId: v.matchup.buildBId,
        modelAId: v.matchup.modelAId,
        modelBId: v.matchup.modelBId,
        samplingLane: v.matchup.samplingLane,
        samplingReason: v.matchup.samplingReason,
      });
    }
    console.log(`votes ${voteRows.length}`);
    if (page.length < VOTE_PAGE_SIZE) break;
    const lastId: string = page[page.length - 1].id;
    cursor = lastId;
  }

  writeJsonl(path.join(outDir, "prompts.jsonl"), prompts);
  writeJsonl(path.join(outDir, "models.jsonl"), models);
  writeJsonl(path.join(outDir, "builds.jsonl"), buildRows);
  writeJsonl(path.join(outDir, "votes.jsonl"), voteRows);

  const failed = buildRows.filter((b) => b.payloadError);
  const restrictedVotes = voteRows.filter((v) => v.restricted).length;
  const storageMismatches = buildRows.filter(
    (b) => b.payloadSource === "storage" && b.payloadSha256 && b.recordedSha256 && b.payloadSha256 !== b.recordedSha256,
  );
  const manifest = {
    snapshotAt,
    gitCommit: execSync("git rev-parse HEAD").toString().trim(),
    counts: { prompts: prompts.length, models: models.length, builds: buildRows.length, votes: voteRows.length },
    excluded: { privateModels: stealthModelIds.size, privateVotes: excludedPrivateVotes },
    payloadFailures: failed.map((b) => ({ id: b.id, error: b.payloadError })),
    storageHashMismatches: storageMismatches.map((b) => b.id),
    storageUpdatedAfterFirstVote: buildRows
      .filter((b) => b.storageUpdatedAt && b.firstVoteAt && b.storageUpdatedAt > b.firstVoteAt)
      .map((b) => b.id),
    restricted: {
      activeBlocks: blocks.length,
      sessions: [...restrictedBySession.values()].filter(Boolean).length,
      votes: restrictedVotes,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify({ outDir, ...manifest.counts, ...manifest.excluded, restricted: manifest.restricted,
    payloadFailures: failed.length,
    storageHashMismatches: storageMismatches.length,
    storageUpdatedAfterFirstVote: manifest.storageUpdatedAfterFirstVote.length }, null, 2));
  await prisma.$disconnect();
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
