import { Prisma } from "@prisma/client";
import { z } from "zod";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { conservativeScore, updateRatingPair } from "@/lib/arena/rating";
import type { VoteChoice } from "@/lib/arena/types";
import { invalidateArenaStatsCache } from "@/lib/arena/stats";
import {
  applyDecisiveVoteCoverageUpdate,
  isDecisiveChoice,
  recordArenaVoteInSamplingCache,
} from "@/lib/arena/coverage";
import { withArenaWriteRetry } from "@/lib/arena/writeRetry";
import { ServerTiming } from "@/lib/serverTiming";

export const runtime = "nodejs";

const SESSION_COOKIE = "mb_session";
const DECISIVE_VOTE_TX_MAX_WAIT_MS = 750;
const DECISIVE_VOTE_TX_TIMEOUT_MS = 2_500;

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

type ModelUpdatePlan = {
  id: string;
  data: Prisma.ModelUpdateInput;
};

type VoteCacheUpdate = {
  decisive: boolean;
  promptId: string;
  modelA: {
    id: string;
    eloRating: number;
    conservativeRating: number;
    ratingDeviation: number;
  };
  modelB: {
    id: string;
    eloRating: number;
    conservativeRating: number;
    ratingDeviation: number;
  };
};

type LockedModelRow = {
  id: string;
  eloRating: number;
  glickoRd: number;
  glickoVolatility: number;
};

function orderModelUpdatePlans(plans: ModelUpdatePlan[]): ModelUpdatePlan[] {
  return [...plans].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function applyOrderedModelUpdates(
  tx: Prisma.TransactionClient,
  plans: ModelUpdatePlan[],
) {
  for (const plan of orderModelUpdatePlans(plans)) {
    await tx.model.update({
      where: { id: plan.id },
      data: plan.data,
    });
  }
}

async function loadModelsForVote(
  tx: Prisma.TransactionClient,
  modelIds: [string, string],
): Promise<Map<string, LockedModelRow>> {
  const orderedIds = Array.from(new Set(modelIds)).sort();
  const rows = await tx.model.findMany({
    where: {
      id: { in: orderedIds },
    },
    select: {
      id: true,
      eloRating: true,
      glickoRd: true,
      glickoVolatility: true,
    },
  });

  if (rows.length !== orderedIds.length) {
    throw new Error("Vote models not found");
  }

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        eloRating: Number(row.eloRating),
        glickoRd: Number(row.glickoRd),
        glickoVolatility: Number(row.glickoVolatility),
      },
    ]),
  );
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
    select: {
      id: true,
      promptId: true,
      modelAId: true,
      modelBId: true,
    },
  });
  timing.end("lookup", lookupStartedAt);

  if (!matchup) return respondJson({ error: "Matchup not found" }, { status: 404 });

  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  const sessionId = getOrSetSessionId(res, req);

  try {
    const txStartedAt = timing.start();
    let cacheUpdate: VoteCacheUpdate | null = null;

    if (choice === "BOTH_BAD") {
      const updates = orderModelUpdatePlans([
        {
          id: matchup.modelAId,
          data: {
            bothBadCount: { increment: 1 },
          },
        },
        {
          id: matchup.modelBId,
          data: {
            bothBadCount: { increment: 1 },
          },
        },
      ]);

      await withArenaWriteRetry(() =>
        prisma.$transaction(
          async (tx) => {
            await loadModelsForVote(tx, [matchup.modelAId, matchup.modelBId]);
            await tx.vote.create({
              data: { matchupId, sessionId, choice },
            });
            await applyOrderedModelUpdates(tx, updates);
          },
          {
            maxWait: DECISIVE_VOTE_TX_MAX_WAIT_MS,
            timeout: DECISIVE_VOTE_TX_TIMEOUT_MS,
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        ),
      );
    } else {
      cacheUpdate = await withArenaWriteRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const lockedModels = await loadModelsForVote(tx, [matchup.modelAId, matchup.modelBId]);
            const modelA = lockedModels.get(matchup.modelAId);
            const modelB = lockedModels.get(matchup.modelBId);
            if (!modelA || !modelB) {
              throw new Error("Vote models not found");
            }

            const outcome = choice === "A" ? "A_WIN" : choice === "B" ? "B_WIN" : "DRAW";
            const updated = updateRatingPair({
              a: {
                rating: modelA.eloRating,
                rd: modelA.glickoRd,
                volatility: modelA.glickoVolatility,
              },
              b: {
                rating: modelB.eloRating,
                rd: modelB.glickoRd,
                volatility: modelB.glickoVolatility,
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

            const updates = orderModelUpdatePlans(
              isDecisiveChoice(choice)
                ? outcome === "A_WIN"
                  ? [
                      {
                        id: matchup.modelAId,
                        data: { ...updateModelA, winCount: { increment: 1 } },
                      },
                      {
                        id: matchup.modelBId,
                        data: { ...updateModelB, lossCount: { increment: 1 } },
                      },
                    ]
                  : [
                      {
                        id: matchup.modelAId,
                        data: { ...updateModelA, lossCount: { increment: 1 } },
                      },
                      {
                        id: matchup.modelBId,
                        data: { ...updateModelB, winCount: { increment: 1 } },
                      },
                    ]
                : [
                    {
                      id: matchup.modelAId,
                      data: { ...updateModelA, drawCount: { increment: 1 } },
                    },
                    {
                      id: matchup.modelBId,
                      data: { ...updateModelB, drawCount: { increment: 1 } },
                    },
                  ],
            );

            await tx.vote.create({
              data: { matchupId, sessionId, choice },
            });
            await applyOrderedModelUpdates(tx, updates);

            if (isDecisiveChoice(choice)) {
              await applyDecisiveVoteCoverageUpdate(tx, {
                modelAId: matchup.modelAId,
                modelBId: matchup.modelBId,
                promptId: matchup.promptId,
              });
            }

            return {
              decisive: isDecisiveChoice(choice),
              promptId: matchup.promptId,
              modelA: {
                id: matchup.modelAId,
                eloRating: updateModelA.eloRating,
                conservativeRating: updateModelA.conservativeRating,
                ratingDeviation: updateModelA.glickoRd,
              },
              modelB: {
                id: matchup.modelBId,
                eloRating: updateModelB.eloRating,
                conservativeRating: updateModelB.conservativeRating,
                ratingDeviation: updateModelB.glickoRd,
              },
            } satisfies VoteCacheUpdate;
          },
          {
            maxWait: DECISIVE_VOTE_TX_MAX_WAIT_MS,
            timeout: DECISIVE_VOTE_TX_TIMEOUT_MS,
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        ),
      );
    }
    timing.end("tx", txStartedAt);
    invalidateArenaStatsCache();
    if (cacheUpdate) {
      recordArenaVoteInSamplingCache(cacheUpdate);
    }
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
