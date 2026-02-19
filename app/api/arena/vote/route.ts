import { z } from "zod";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { conservativeScore, updateRatingPair } from "@/lib/arena/rating";
import type { VoteChoice } from "@/lib/arena/types";
import { invalidateArenaStatsCache } from "@/lib/arena/stats";

export const runtime = "nodejs";

const SESSION_COOKIE = "mb_session";

const reqSchema = z.object({
  matchupId: z.string().min(1),
  choice: z.union([z.literal("A"), z.literal("B"), z.literal("TIE"), z.literal("BOTH_BAD")]),
});

function getOrSetSessionId(res: NextResponse, req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const existing = match?.[1];
  if (existing) return existing;

  const id = crypto.randomUUID();
  res.cookies.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

export async function POST(req: Request) {
  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = reqSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const { matchupId, choice } = parsed.data as { matchupId: string; choice: VoteChoice };

  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { modelA: true, modelB: true },
  });

  if (!matchup) return NextResponse.json({ error: "Matchup not found" }, { status: 404 });

  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  const sessionId = getOrSetSessionId(res, req);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.vote.create({
        data: { matchupId, sessionId, choice },
      });

      const a = matchup.modelA;
      const b = matchup.modelB;

      if (choice === "BOTH_BAD") {
        await tx.model.update({
          where: { id: a.id },
          data: {
            bothBadCount: { increment: 1 },
          },
        });
        await tx.model.update({
          where: { id: b.id },
          data: {
            bothBadCount: { increment: 1 },
          },
        });
        return;
      }

      const outcome =
        choice === "A" ? "A_WIN" : choice === "B" ? "B_WIN" : "DRAW";
      const updated = updateRatingPair({
        a: {
          rating: Number(a.eloRating),
          rd: Number(a.glickoRd),
          volatility: Number(a.glickoVolatility),
        },
        b: {
          rating: Number(b.eloRating),
          rd: Number(b.glickoRd),
          volatility: Number(b.glickoVolatility),
        },
        outcome,
      });

      const updateModelA = {
        eloRating: updated.a.rating,
        glickoRd: updated.a.rd,
        glickoVolatility: updated.a.volatility,
        conservativeRating: conservativeScore(updated.a.rating, updated.a.rd),
      };
      const updateModelB = {
        eloRating: updated.b.rating,
        glickoRd: updated.b.rd,
        glickoVolatility: updated.b.volatility,
        conservativeRating: conservativeScore(updated.b.rating, updated.b.rd),
      };

      if (outcome === "A_WIN") {
        await tx.model.update({
          where: { id: a.id },
          data: { ...updateModelA, winCount: { increment: 1 } },
        });
        await tx.model.update({
          where: { id: b.id },
          data: { ...updateModelB, lossCount: { increment: 1 } },
        });
      } else if (outcome === "B_WIN") {
        await tx.model.update({
          where: { id: a.id },
          data: { ...updateModelA, lossCount: { increment: 1 } },
        });
        await tx.model.update({
          where: { id: b.id },
          data: { ...updateModelB, winCount: { increment: 1 } },
        });
      } else {
        await tx.model.update({
          where: { id: a.id },
          data: { ...updateModelA, drawCount: { increment: 1 } },
        });
        await tx.model.update({
          where: { id: b.id },
          data: { ...updateModelB, drawCount: { increment: 1 } },
        });
      }
    });
    invalidateArenaStatsCache();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Vote failed";
    return NextResponse.json({ error: msg }, { status: 409 });
  }

  return res;
}
