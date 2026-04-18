import { z } from "zod";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { conservativeScore, updateRatingPair } from "@/lib/arena/rating";
import type { VoteChoice } from "@/lib/arena/types";
import { invalidateArenaStatsCache } from "@/lib/arena/stats";
import {
  applyDecisiveVoteCoverageUpdate,
  isDecisiveChoice,
} from "@/lib/arena/coverage";
import { ServerTiming } from "@/lib/serverTiming";

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
  const timing = new ServerTiming();
  const requestStartedAt = timing.start();
  let finalized = false;
  const finalizeHeaders = (headers?: HeadersInit) => {
    const nextHeaders = new Headers(headers);
    if (!finalized) {
      timing.end("total", requestStartedAt);
      finalized = true;
    }
    timing.apply(nextHeaders);
    return nextHeaders;
  };
  const respondJson = (body: unknown, init?: ResponseInit) =>
    NextResponse.json(body, {
      ...init,
      headers: finalizeHeaders(init?.headers),
    });

  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = reqSchema.safeParse(json);
  if (!parsed.success) {
    return respondJson({ error: parsed.error.message }, { status: 400 });
  }

  const { matchupId, choice } = parsed.data as { matchupId: string; choice: VoteChoice };

  const lookupStartedAt = timing.start();
  const matchup = await prisma.matchup.findUnique({
    where: { id: matchupId },
    include: { modelA: true, modelB: true },
  });
  timing.end("lookup", lookupStartedAt);

  if (!matchup) return respondJson({ error: "Matchup not found" }, { status: 404 });

  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  const sessionId = getOrSetSessionId(res, req);

  try {
    const txStartedAt = timing.start();
    const a = matchup.modelA;
    const b = matchup.modelB;

    if (choice === "BOTH_BAD") {
      await prisma.$transaction([
        prisma.vote.create({
          data: { matchupId, sessionId, choice },
        }),
        prisma.model.update({
          where: { id: a.id },
          data: {
            bothBadCount: { increment: 1 },
          },
        }),
        prisma.model.update({
          where: { id: b.id },
          data: {
            bothBadCount: { increment: 1 },
          },
        }),
      ]);
    } else {
      const outcome = choice === "A" ? "A_WIN" : choice === "B" ? "B_WIN" : "DRAW";
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

      if (isDecisiveChoice(choice)) {
        await prisma.$transaction(async (tx) => {
          await tx.vote.create({
            data: { matchupId, sessionId, choice },
          });

          if (outcome === "A_WIN") {
            await Promise.all([
              tx.model.update({
                where: { id: a.id },
                data: { ...updateModelA, winCount: { increment: 1 } },
              }),
              tx.model.update({
                where: { id: b.id },
                data: { ...updateModelB, lossCount: { increment: 1 } },
              }),
            ]);
          } else {
            await Promise.all([
              tx.model.update({
                where: { id: a.id },
                data: { ...updateModelA, lossCount: { increment: 1 } },
              }),
              tx.model.update({
                where: { id: b.id },
                data: { ...updateModelB, winCount: { increment: 1 } },
              }),
            ]);
          }

          await applyDecisiveVoteCoverageUpdate(tx, {
            modelAId: a.id,
            modelBId: b.id,
            promptId: matchup.promptId,
          });
        });
      } else {
        await prisma.$transaction([
          prisma.vote.create({
            data: { matchupId, sessionId, choice },
          }),
          prisma.model.update({
            where: { id: a.id },
            data: { ...updateModelA, drawCount: { increment: 1 } },
          }),
          prisma.model.update({
            where: { id: b.id },
            data: { ...updateModelB, drawCount: { increment: 1 } },
          }),
        ]);
      }
    }
    timing.end("tx", txStartedAt);
    invalidateArenaStatsCache();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Vote failed";
    return respondJson({ error: msg }, { status: 409 });
  }

  if (!finalized) {
    timing.end("total", requestStartedAt);
    finalized = true;
  }
  timing.apply(res.headers);
  return res;
}
