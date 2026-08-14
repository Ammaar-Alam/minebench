import { Prisma } from "@prisma/client";
import { z } from "zod";
import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { VoteChoice } from "@/lib/arena/types";
import { hasArenaMatchupSigningSecret, parseArenaMatchupToken } from "@/lib/arena/matchupToken";
import { recordArenaVoteQueuedForSampling } from "@/lib/arena/coverage";
import { shouldScheduleArenaVoteJobDrainAfterResponse } from "@/lib/arena/drainConfig";
import { scheduleArenaVoteJobDrain } from "@/lib/arena/voteJobs";
import { isArenaCapacityError, withArenaWriteRetry } from "@/lib/arena/writeRetry";
import { ServerTiming } from "@/lib/serverTiming";

export const runtime = "nodejs";

const SESSION_COOKIE = "mb_session";

const reqSchema = z.object({
  matchupId: z.string().min(1).max(2048),
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

function isCapacityVoteError(error: unknown): boolean {
  return isArenaCapacityError(error);
}

function isDuplicateVoteError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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

  let res: NextResponse | null = null;
  let queuedVoteJobs = 0;
  let queuedVoteJobInput:
    | {
        voteJobId: string;
        promptId: string;
        modelAId: string;
        modelBId: string;
        choice: VoteChoice;
      }
    | null = null;

  try {
    const lookupStartedAt = timing.start();
    if (!hasArenaMatchupSigningSecret()) {
      return respondJson(
        { error: "Arena matchup token signing is not configured." },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    const tokenMatchup = parseArenaMatchupToken(matchupId);
    timing.end("lookup", lookupStartedAt);
    if (!tokenMatchup) return respondJson({ error: "Matchup not found" }, { status: 404 });
    const dbMatchupId = tokenMatchup.id;
    const matchup = {
      promptId: tokenMatchup.promptId,
      modelAId: tokenMatchup.modelAId,
      modelBId: tokenMatchup.modelBId,
      buildAId: tokenMatchup.buildAId,
      buildBId: tokenMatchup.buildBId,
      samplingLane: tokenMatchup.samplingLane ?? null,
      samplingReason: tokenMatchup.samplingReason ?? null,
    };
    res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    const sessionId = getOrSetSessionId(res, req);
    const txStartedAt = timing.start();
    const voteId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const validMatchupSql = Prisma.sql`
      SELECT 1
      FROM "Build" AS build_a
      INNER JOIN "Model" AS model_a ON model_a."id" = build_a."modelId"
      CROSS JOIN "Build" AS build_b
      INNER JOIN "Model" AS model_b ON model_b."id" = build_b."modelId"
      WHERE build_a."id" = ${tokenMatchup.buildAId}
        AND build_a."promptId" = ${tokenMatchup.promptId}
        AND build_a."modelId" = ${tokenMatchup.modelAId}
        AND BTRIM(build_a."voxelSha256") = ${tokenMatchup.buildAChecksum}
        AND model_a."enabled" = true
        AND build_b."id" = ${tokenMatchup.buildBId}
        AND build_b."promptId" = ${tokenMatchup.promptId}
        AND build_b."modelId" = ${tokenMatchup.modelBId}
        AND BTRIM(build_b."voxelSha256") = ${tokenMatchup.buildBChecksum}
        AND model_b."enabled" = true
      FOR SHARE OF build_a, build_b, model_a, model_b
    `;
    const [voteWrite] = await withArenaWriteRetry(async () => {
      return prisma.$queryRaw<Array<{ validMatchup: boolean; voteId: string | null }>>(Prisma.sql`
        WITH valid_matchup AS (
          ${validMatchupSql}
        ),
        inserted_matchup AS (
          INSERT INTO "Matchup" (
            "id",
            "promptId",
            "modelAId",
            "modelBId",
            "buildAId",
            "buildBId",
            "samplingLane",
            "samplingReason"
          )
          SELECT
            ${dbMatchupId},
            ${matchup.promptId},
            ${matchup.modelAId},
            ${matchup.modelBId},
            ${matchup.buildAId},
            ${matchup.buildBId},
            ${matchup.samplingLane},
            ${matchup.samplingReason}
          FROM valid_matchup
          ON CONFLICT ("id") DO NOTHING
        ),
        inserted_vote AS (
          INSERT INTO "Vote" (
            "id",
            "matchupId",
            "sessionId",
            "choice"
          )
          SELECT ${voteId}, ${dbMatchupId}, ${sessionId}, ${choice}
          FROM valid_matchup
          ON CONFLICT ("matchupId", "sessionId") DO NOTHING
          RETURNING "id"
        ),
        inserted_job AS (
          INSERT INTO "ArenaVoteJob" (
            "id",
            "voteId",
            "matchupId",
            "promptId",
            "modelAId",
            "modelBId",
            "choice"
          )
          SELECT
            ${jobId},
            "id",
            ${dbMatchupId},
            ${matchup.promptId},
            ${matchup.modelAId},
            ${matchup.modelBId},
            ${choice}
          FROM inserted_vote
          RETURNING "voteId"
        )
        SELECT
          EXISTS (SELECT 1 FROM valid_matchup) AS "validMatchup",
          (SELECT "voteId" FROM inserted_job LIMIT 1) AS "voteId"
      `);
    });
    timing.end("tx", txStartedAt);
    if (!voteWrite?.validMatchup) {
      return respondJson({ error: "Matchup is no longer active" }, { status: 409 });
    }

    queuedVoteJobs = voteWrite.voteId ? 1 : 0;
    if (queuedVoteJobs > 0) {
      queuedVoteJobInput = {
        voteJobId: jobId,
        promptId: matchup.promptId,
        modelAId: matchup.modelAId,
        modelBId: matchup.modelBId,
        choice,
      };
    }
  } catch (err) {
    if (res && isDuplicateVoteError(err)) {
      if (!finalized) {
        timing.end("total", requestStartedAt);
        finalized = true;
      }
      timing.apply(res.headers);
      return res;
    }
    const capacityError = isCapacityVoteError(err);
    const msg = err instanceof Error ? err.message : "Vote failed";
    return respondJson(
      { error: msg },
      {
        status: capacityError ? 503 : 409,
        headers: capacityError ? { "Retry-After": "1" } : undefined,
      },
    );
  }

  if (!finalized) {
    timing.end("total", requestStartedAt);
    finalized = true;
  }
  if (!res) {
    return respondJson({ error: "Vote failed" }, { status: 409 });
  }
  if (queuedVoteJobInput) {
    recordArenaVoteQueuedForSampling(queuedVoteJobInput);
  }
  if (shouldScheduleArenaVoteJobDrainAfterResponse(queuedVoteJobs)) {
    after(() =>
      scheduleArenaVoteJobDrain().catch((error) => {
        console.warn("arena vote job drain failed", error);
      }),
    );
  }
  timing.apply(res.headers);
  return res;
}
