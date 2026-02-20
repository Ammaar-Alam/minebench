import { NextResponse } from "next/server";
import { confidenceFromRd } from "@/lib/arena/rating";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function requireAdminOrCron(req: Request): string | null {
  const allowedTokens = [process.env.ADMIN_TOKEN, process.env.CRON_SECRET]
    .map((token) => token?.trim())
    .filter((token): token is string => Boolean(token));
  if (allowedTokens.length === 0) return "Missing ADMIN_TOKEN or CRON_SECRET on server";

  const auth = req.headers.get("authorization");
  if (!auth) return "Missing Authorization header (expected: Authorization: Bearer <token>)";

  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "Invalid Authorization header (expected: Authorization: Bearer <token>)";

  const presented = match[1]?.trim();
  if (!presented) return "Empty Bearer token";
  if (!allowedTokens.includes(presented)) return "Invalid token";
  return null;
}

function floorToUtcHour(date: Date): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

async function capture(req: Request) {
  const denied = requireAdminOrCron(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const url = new URL(req.url);
  const atParam = url.searchParams.get("at");
  const anchor = atParam ? new Date(atParam) : new Date();

  if (!Number.isFinite(anchor.getTime())) {
    return NextResponse.json(
      { error: "Invalid 'at' query parameter. Use an ISO timestamp." },
      { status: 400 },
    );
  }

  const capturedAt = floorToUtcHour(anchor);

  const models = await prisma.model.findMany({
    where: { enabled: true, isBaseline: false },
    orderBy: [{ conservativeRating: "desc" }, { displayName: "asc" }],
    select: {
      id: true,
      key: true,
      displayName: true,
      conservativeRating: true,
      glickoRd: true,
    },
  });

  const snapshots = models.map((model, index) => ({
    modelId: model.id,
    rank: index + 1,
    rankScore: Number(model.conservativeRating),
    confidence: confidenceFromRd(Number(model.glickoRd)),
  }));

  if (snapshots.length > 0) {
    await prisma.$transaction(
      snapshots.map((snapshot) =>
        prisma.modelRankSnapshot.upsert({
          where: {
            capturedAt_modelId: {
              capturedAt,
              modelId: snapshot.modelId,
            },
          },
          create: {
            capturedAt,
            modelId: snapshot.modelId,
            rank: snapshot.rank,
            rankScore: snapshot.rankScore,
            confidence: snapshot.confidence,
          },
          update: {
            rank: snapshot.rank,
            rankScore: snapshot.rankScore,
            confidence: snapshot.confidence,
          },
        }),
      ),
    );
  }

  return NextResponse.json({
    ok: true,
    capturedAt: capturedAt.toISOString(),
    modelCount: snapshots.length,
    updated: snapshots.length,
    top: models.slice(0, 3).map((model, index) => ({
      key: model.key,
      displayName: model.displayName,
      rank: index + 1,
    })),
  });
}

export async function POST(req: Request) {
  return capture(req);
}

export async function GET(req: Request) {
  return capture(req);
}
