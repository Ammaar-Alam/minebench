import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getArenaShownJobStatus } from "@/lib/arena/shownJobs";
import { getArenaArtifactCoverage } from "@/lib/arena/artifactCoverage";
import { findCatalogEntryBySlugOrKey } from "@/lib/ai/modelCatalog";
import { ServerTiming } from "@/lib/serverTiming";
import { supabaseProjectRefFromDatabaseUrl } from "@/lib/db/identity";

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
    return {
      projectRef: supabaseProjectRefFromDatabaseUrl(url),
      host: u.hostname,
      port: u.port || "5432",
      database: u.pathname.replace(/^\//, "") || "unknown",
      pgbouncer: u.searchParams.get("pgbouncer") === "true",
      connectionLimit: u.searchParams.get("connection_limit"),
      poolTimeout: u.searchParams.get("pool_timeout"),
    };
  } catch {
    return {
      host: "unknown",
      port: "unknown",
      database: "unknown",
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
    ] = await Promise.all([
      prisma.prompt.count(),
      prisma.prompt.count({ where: { active: true } }),
      prisma.model.count(),
      prisma.model.count({ where: { enabled: true, isBaseline: false } }),
      prisma.build.count(),
      prisma.matchup.count(),
      prisma.vote.count(),
      getArenaArtifactCoverage(modelKeys),
      getArenaVoteJobStatus(),
      getArenaShownJobStatus(),
    ]);
    timing.end("artifact_status", artifactStartedAt);
    timing.end("total", requestStartedAt);

    const headers = new Headers({ "Cache-Control": "no-store" });
    timing.apply(headers);

    return NextResponse.json(
      {
        ok: true,
        db: getDbInfo(),
        counts: {
          prompts: { total: promptTotal, active: promptActive },
          models: { total: modelTotal, enabled: modelEnabled },
          builds: { total: buildTotal },
          matchups: { total: matchupTotal },
          votes: { total: voteTotal },
        },
        artifacts: { ...(modelEntry ? { modelKey: modelEntry.key } : {}), ...artifactCoverage },
        voteJobs,
        shownJobs,
      },
      { headers }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status query failed";
    return NextResponse.json({ error: message, db: getDbInfo() }, { status: 500 });
  }
}
