import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { LeaderboardResponse } from "@/lib/arena/types";
import { getLeaderboardDispersionByModelId } from "@/lib/arena/stats";

export const runtime = "nodejs";

export async function GET() {
  const [models, dispersionByModelId] = await Promise.all([
    prisma.model.findMany({
      where: { isBaseline: false, enabled: true },
      orderBy: { eloRating: "desc" },
      select: {
        id: true,
        key: true,
        provider: true,
        displayName: true,
        eloRating: true,
        shownCount: true,
        winCount: true,
        lossCount: true,
        drawCount: true,
        bothBadCount: true,
      },
    }),
    getLeaderboardDispersionByModelId(),
  ]);

  const body: LeaderboardResponse = {
    models: models.map((m) => {
      const dispersion = dispersionByModelId.get(m.id);
      return {
        key: m.key,
        provider: m.provider,
        displayName: m.displayName,
        eloRating: Number(m.eloRating),
        shownCount: m.shownCount,
        winCount: m.winCount,
        lossCount: m.lossCount,
        drawCount: m.drawCount,
        bothBadCount: m.bothBadCount,
        meanScore: dispersion?.meanScore ?? null,
        scoreVariance: dispersion?.scoreVariance ?? null,
        scoreSpread: dispersion?.scoreSpread ?? null,
        consistency: dispersion?.consistency ?? null,
        sampledPrompts: dispersion?.sampledPrompts ?? 0,
        sampledVotes: dispersion?.sampledVotes ?? 0,
      };
    }),
  };

  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
