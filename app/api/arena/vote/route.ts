import { Prisma } from "@prisma/client";
import { z } from "zod";
import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { VoteChoice } from "@/lib/arena/types";
import { hasArenaMatchupSigningSecret, parseArenaMatchupToken } from "@/lib/arena/matchupToken";
import { isArenaCapacityError, withArenaWriteRetry } from "@/lib/arena/writeRetry";
import { scheduleArenaVoteJobDrain } from "@/lib/arena/voteJobs";
import { ServerTiming } from "@/lib/serverTiming";

export const runtime = "nodejs";

const SESSION_COOKIE = "mb_session";
const VOTE_JOB_DRAIN_AFTER_RESPONSE = readBoolEnv("ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE", true);

const reqSchema = z.object({
  matchupId: z.string().min(1).max(2048),
  choice: z.union([z.literal("A"), z.literal("B"), z.literal("TIE"), z.literal("BOTH_BAD")]),
});

function readBoolEnv(name: string, fallback: boolean): boolean {
  const normalized = process.env[name]?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

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

  try {
    const lookupStartedAt = timing.start();
    if (matchupId.includes(".") && !hasArenaMatchupSigningSecret()) {
      return respondJson(
        { error: "Arena matchup token signing is not configured." },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    const tokenMatchup = parseArenaMatchupToken(matchupId);
    const dbMatchupId = tokenMatchup?.id ?? matchupId;
    const matchup = tokenMatchup
      ? {
          id: tokenMatchup.id,
          promptId: tokenMatchup.promptId,
          modelAId: tokenMatchup.modelAId,
          modelBId: tokenMatchup.modelBId,
          buildAId: tokenMatchup.buildAId,
          buildBId: tokenMatchup.buildBId,
          samplingLane: tokenMatchup.samplingLane ?? null,
          samplingReason: tokenMatchup.samplingReason ?? null,
        }
      : await prisma.matchup.findUnique({
          where: { id: dbMatchupId },
          select: {
            id: true,
            promptId: true,
            modelAId: true,
            modelBId: true,
            buildAId: true,
            buildBId: true,
            samplingLane: true,
            samplingReason: true,
          },
        });
    timing.end("lookup", lookupStartedAt);

    if (!matchup) return respondJson({ error: "Matchup not found" }, { status: 404 });

    res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    const sessionId = getOrSetSessionId(res, req);
    const txStartedAt = timing.start();
    const voteId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const insertedRows = await withArenaWriteRetry(async () => {
      return prisma.$queryRaw<Array<{ voteId: string }>>(Prisma.sql`
        WITH inserted_matchup AS (
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
          VALUES (
            ${dbMatchupId},
            ${matchup.promptId},
            ${matchup.modelAId},
            ${matchup.modelBId},
            ${matchup.buildAId},
            ${matchup.buildBId},
            ${matchup.samplingLane},
            ${matchup.samplingReason}
          )
          ON CONFLICT ("id") DO NOTHING
        ),
        inserted_vote AS (
          INSERT INTO "Vote" (
            "id",
            "matchupId",
            "sessionId",
            "choice"
          )
          VALUES (${voteId}, ${dbMatchupId}, ${sessionId}, ${choice})
          ON CONFLICT ("matchupId", "sessionId") DO NOTHING
          RETURNING "id"
        )
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
      `);
    });
    timing.end("tx", txStartedAt);
    if (insertedRows.length > 0) {
      if (VOTE_JOB_DRAIN_AFTER_RESPONSE) {
        after(() => scheduleArenaVoteJobDrain());
      }
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
  timing.apply(res.headers);
  return res;
}
