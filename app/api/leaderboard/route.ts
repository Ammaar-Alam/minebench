import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { LeaderboardResponse } from "@/lib/arena/types";

export const runtime = "nodejs";

export async function GET() {
  const models = await prisma.model.findMany({
    where: { isBaseline: false, enabled: true },
    orderBy: { eloRating: "desc" },
    select: {
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
  });

  const body: LeaderboardResponse = {
    models: models.map((m) => ({ ...m, eloRating: Number(m.eloRating) })),
  };

  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

