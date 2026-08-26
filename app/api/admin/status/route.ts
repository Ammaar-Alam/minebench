import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getArenaShownJobStatus } from "@/lib/arena/shownJobs";
import { getArenaArtifactCoverage } from "@/lib/arena/artifactCoverage";
import { ARENA_MATCHUP_STATE_CACHE_TTL_MS } from "@/lib/arena/coverage";
import { findCatalogEntryBySlugOrKey } from "@/lib/ai/modelCatalog";
import { ServerTiming } from "@/lib/serverTiming";
import { databaseIdentityFromUrl } from "@/lib/db/identity";
import { getSupabaseStorageReadiness } from "@/lib/storage/buildPayload";
import { PUBLIC_SESSION_RETENTION_MS } from "@/lib/publicPresence";

export const runtime = "nodejs";

function requireAdmin(req: Request): string | null {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return "Missing ADMIN_TOKEN on server";

  const auth = req.headers.get("authorization");
  if (!auth) return "Missing Authorization header (expected: Authorization: Bearer <ADMIN_TOKEN>)";

  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "Invalid Authorization header (expected: Authorization: Bearer <ADMIN_TOKEN>)";

  const presented = match[1]?.trim();
  if (!presented) return "Empty Bearer token";
  if (presented !== token.trim()) return "Invalid token";
  return null;
}

function getDbInfo() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const u = new URL(url);
    const identity = databaseIdentityFromUrl(url);
    if (!identity) throw new Error("Invalid database URL");
    return {
      ...identity,
      pgbouncer: u.searchParams.get("pgbouncer") === "true",
      connectionLimit: u.searchParams.get("connection_limit"),
      poolTimeout: u.searchParams.get("pool_timeout"),
    };
  } catch {
    return {
      host: "unknown",
      port: "unknown",
      database: "unknown",
      schema: "unknown",
      pgbouncer: false,
      connectionLimit: null,
      poolTimeout: null,
    };
  }
}

async function getArenaVoteJobStatus() {
  const [pendingCount, oldestPending] = await Promise.all([
    prisma.arenaVoteJob.count({ where: { processedAt: null } }),
    prisma.arenaVoteJob.findFirst({
      where: { processedAt: null },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    pendingCount,
    oldestPendingAgeMs: oldestPending
      ? Math.max(0, Date.now() - oldestPending.createdAt.getTime())
      : null,
  };
}

async function getCustomBuildOpsStatus() {
  const now = new Date();
  const [
    queued,
    running,
    succeeded,
    failed,
    canceled,
    jobsQueued,
    jobsRunning,
    jobsFailed,
    oldestQueuedJob,
    staleLeases,
    artifactAggregate,
    retainedAggregate,
    pendingObjectDeletions,
    dueGenerations,
    dueCandidates,
    dueExamples,
    dueModerationRecords,
    duePublicSessions,
    emailDeliveryFailures,
  ] = await Promise.all([
    prisma.customBuild.count({ where: { status: "queued" } }),
    prisma.customBuild.count({ where: { status: "running" } }),
    prisma.customBuild.count({ where: { status: "succeeded" } }),
    prisma.customBuild.count({ where: { status: "failed" } }),
    prisma.customBuild.count({ where: { status: "canceled" } }),
    prisma.customBuildJob.count({ where: { status: "queued" } }),
    prisma.customBuildJob.count({ where: { status: "running" } }),
    prisma.customBuildJob.count({ where: { status: "failed" } }),
    prisma.customBuildJob.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.customBuildJob.count({
      where: {
        status: "running",
        leaseExpiresAt: { lt: new Date() },
      },
    }),
    prisma.customBuildArtifact.aggregate({
      _count: { id: true },
      _sum: {
        compressedByteSize: true,
        byteSize: true,
        storedByteSize: true,
      },
    }),
    prisma.customBuild.aggregate({ _sum: { storedByteSize: true } }),
    prisma.customBuild.count({ where: { deletionPendingAt: { not: null } } }),
    prisma.customBuild.count({ where: { removedAt: { not: null }, purgeAt: { lte: now } } }),
    prisma.galleryCandidate.count({
      where: { purgeAt: { lte: now }, selectedAt: null, officialPromptId: null },
    }),
    prisma.galleryExample.count({ where: { purgeAt: { lte: now } } }),
    prisma.galleryModerationRecord.count({ where: { purgeAt: { lte: now } } }),
    prisma.publicSessionActivity.count({
      where: { lastSeenAt: { lte: new Date(now.getTime() - PUBLIC_SESSION_RETENTION_MS) } },
    }),
    prisma.galleryModerationRecord.count({ where: { action: "email_delivery_failed" } }),
  ]);

  return {
    counts: {
      queued,
      running,
      succeeded,
      failed,
      canceled,
    },
    jobs: {
      queued: jobsQueued,
      running: jobsRunning,
      failed: jobsFailed,
      oldestQueuedAgeMs: oldestQueuedJob ? Math.max(0, Date.now() - oldestQueuedJob.createdAt.getTime()) : null,
      staleLeases,
    },
    artifacts: {
      objects: artifactAggregate._count.id,
      compressedBytes: artifactAggregate._sum.compressedByteSize ?? 0,
      logicalBytes: artifactAggregate._sum.byteSize ?? 0,
      storedBytes: artifactAggregate._sum.storedByteSize ?? 0,
    },
    retainedStoredBytes: retainedAggregate._sum.storedByteSize ?? 0,
    pendingObjectDeletions,
    purgeBacklog:
      dueGenerations + dueCandidates + dueExamples + dueModerationRecords + duePublicSessions,
    emailDeliveryFailures,
  };
}

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const modelParam = new URL(req.url).searchParams.get("modelKey");
  const modelEntry = modelParam ? findCatalogEntryBySlugOrKey(modelParam) : null;
  if (modelParam && !modelEntry) {
    return NextResponse.json(
      { error: `Unknown model key or slug: ${modelParam}` },
      { status: 400 },
    );
  }
  const modelKeys = modelEntry ? [modelEntry.key] : undefined;

  try {
    const timing = new ServerTiming();
    const requestStartedAt = timing.start();
    const artifactStartedAt = timing.start();
    const [
      promptTotal,
      promptActive,
      modelTotal,
      modelEnabled,
      buildTotal,
      matchupTotal,
      voteTotal,
      artifactCoverage,
      voteJobs,
      shownJobs,
      storage,
      customBuilds,
    ] = await Promise.all([
      prisma.prompt.count(),
      prisma.prompt.count({ where: { active: true } }),
      prisma.model.count(),
      prisma.model.count({ where: { enabled: true, isBaseline: false, stealthVariant: null } }),
      prisma.build.count(),
      prisma.matchup.count(),
      prisma.vote.count(),
      getArenaArtifactCoverage(modelKeys),
      getArenaVoteJobStatus(),
      getArenaShownJobStatus(),
      getSupabaseStorageReadiness(),
      getCustomBuildOpsStatus(),
    ]);
    timing.end("artifact_status", artifactStartedAt);
    timing.end("total", requestStartedAt);

    const headers = new Headers({ "Cache-Control": "no-store" });
    timing.apply(headers);

    return NextResponse.json(
      {
        ok: true,
        db: getDbInfo(),
        arena: { matchupStateCacheTtlMs: ARENA_MATCHUP_STATE_CACHE_TTL_MS },
        counts: {
          prompts: { total: promptTotal, active: promptActive },
          models: { total: modelTotal, enabled: modelEnabled },
          builds: { total: buildTotal },
          matchups: { total: matchupTotal },
          votes: { total: voteTotal },
        },
        artifacts: { ...(modelEntry ? { modelKey: modelEntry.key } : {}), ...artifactCoverage },
        storage,
        voteJobs,
        shownJobs,
        customBuilds,
      },
      { headers }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status query failed";
    return NextResponse.json({ error: message, db: getDbInfo() }, { status: 500 });
  }
}
