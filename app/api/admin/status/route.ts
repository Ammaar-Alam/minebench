import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
      host: u.hostname,
      port: u.port || "5432",
      database: u.pathname.replace(/^\//, "") || "unknown",
      pgbouncer: u.searchParams.get("pgbouncer") === "true",
    };
  } catch {
    return { host: "unknown", port: "unknown", database: "unknown", pgbouncer: false };
  }
}

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  try {
    const [
      promptTotal,
      promptActive,
      modelTotal,
      modelEnabled,
      buildTotal,
      matchupTotal,
      voteTotal,
    ] = await Promise.all([
      prisma.prompt.count(),
      prisma.prompt.count({ where: { active: true } }),
      prisma.model.count(),
      prisma.model.count({ where: { enabled: true, isBaseline: false } }),
      prisma.build.count(),
      prisma.matchup.count(),
      prisma.vote.count(),
    ]);

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
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status query failed";
    return NextResponse.json({ error: message, db: getDbInfo() }, { status: 500 });
  }
}

