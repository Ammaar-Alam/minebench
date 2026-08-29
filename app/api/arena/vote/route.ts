import { Prisma } from "@prisma/client";
import { z } from "zod";
import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { ArenaAction, ArenaModelReveal, ArenaVoteResponse, VoteChoice } from "@/lib/arena/types";
import { hasArenaMatchupSigningSecret, parseArenaMatchupToken } from "@/lib/arena/matchupToken";
import { recordArenaVoteQueuedForSampling } from "@/lib/arena/coverage";
import { shouldScheduleArenaVoteJobDrainAfterResponse } from "@/lib/arena/drainConfig";
import { scheduleArenaVoteJobDrain } from "@/lib/arena/voteJobs";
import { isArenaCapacityError, withArenaWriteRetry } from "@/lib/arena/writeRetry";
import { ServerTiming } from "@/lib/serverTiming";
import { resolveModelDisplayName } from "@/lib/ai/modelCatalog";
import { invalidateStealthSamplingCache } from "@/lib/stealth/sampling";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import {
  ARENA_SESSION_COOKIE,
  ARENA_SESSION_COOKIE_OPTIONS,
  readArenaSessionId,
} from "@/lib/arena/session";
import { logArenaVoteRequest } from "@/lib/observability/arenaVoteLog";
import { isVoteWriteBlocked, trustedClientIp } from "@/lib/voteBlock";

export const runtime = "nodejs";

const reqSchema = z.object({
  matchupId: z.string().min(1).max(2048),
  choice: z.union([
    z.literal("A"),
    z.literal("B"),
    z.literal("TIE"),
    z.literal("BOTH_BAD"),
    z.literal("SKIP"),
  ]),
});

function getOrCreateSessionId(req: Request): { id: string; cookieValue: string | null } {
  const existing = readArenaSessionId(req.headers.get("cookie"));
  if (existing) return { id: existing, cookieValue: null };

  const id = crypto.randomUUID();
  return { id, cookieValue: id };
}

function isCapacityVoteError(error: unknown): boolean {
  return isArenaCapacityError(error);
}

async function loadMatchupReveal(
  modelAId: string,
  modelBId: string,
): Promise<ArenaVoteResponse["reveal"] | null> {
  const models = await prisma.model.findMany({
    where: { id: { in: [modelAId, modelBId] } },
    select: {
      id: true,
      key: true,
      provider: true,
      displayName: true,
      stealthVariant: { select: { codename: true } },
    },
  });
  const reveals = new Map<string, ArenaModelReveal>(
    models.map((model) => [
      model.id,
      model.stealthVariant
        ? { provider: "Stealth", displayName: model.stealthVariant.codename }
        : {
            provider: model.provider,
            displayName: resolveModelDisplayName(model.key, model.displayName),
          },
    ]),
  );
  const a = reveals.get(modelAId);
  const b = reveals.get(modelBId);
  return a && b ? { a, b } : null;
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

  const { matchupId, choice: action } = parsed.data as { matchupId: string; choice: ArenaAction };

  let res: NextResponse | null = null;
  let queuedVoteJobs = 0;
  let queuedVoteJobInput:
    | {
        voteJobId: string;
        promptId: string;
        modelAId: string;
        modelBId: string;
        choice: VoteChoice;
        stealthVariantId?: string;
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
      stealthVariantId: tokenMatchup.stealthVariantId ?? null,
    };
    if (action === "SKIP") {
      const revealStartedAt = timing.start();
      const reveal = await loadMatchupReveal(matchup.modelAId, matchup.modelBId);
      timing.end("reveal", revealStartedAt);
      if (!reveal) {
        return respondJson({ error: "Matchup reveal is unavailable" }, { status: 409 });
      }
      const responseBody: ArenaVoteResponse = { ok: true, reveal };
      return respondJson(responseBody, { headers: { "Cache-Control": "no-store" } });
    }

    const choice: VoteChoice = action;
    const revealStartedAt = timing.start();
    const reveal = await loadMatchupReveal(matchup.modelAId, matchup.modelBId);
    timing.end("reveal", revealStartedAt);
    if (!reveal) {
      return respondJson({ error: "Matchup reveal is unavailable" }, { status: 409 });
    }
    const session = getOrCreateSessionId(req);
    const sessionId = session.id;
    const authUserId = await getAuthenticatedUserId(req);
    const blocked = await isVoteWriteBlocked({
      userId: authUserId,
      sessionId,
      ip: trustedClientIp(req.headers),
    });
    if (blocked) {
      const blockedResponse = NextResponse.json(
        { ok: true, reveal } satisfies ArenaVoteResponse,
        { headers: finalizeHeaders({ "Cache-Control": "no-store" }) },
      );
      if (session.cookieValue) {
        blockedResponse.cookies.set(
          ARENA_SESSION_COOKIE,
          session.cookieValue,
          ARENA_SESSION_COOKIE_OPTIONS,
        );
      }
      return blockedResponse;
    }
    const voteOwnerSql = !matchup.stealthVariantId && authUserId
      ? Prisma.sql`(SELECT id FROM "User" WHERE id = CAST(${authUserId} AS UUID))`
      : Prisma.sql`NULL`;
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
        AND ${
          tokenMatchup.stealthVariantId
            ? Prisma.sql`EXISTS (
                SELECT 1
                FROM "StealthVariant" variant
                INNER JOIN "StealthExperiment" experiment ON experiment.id = variant."experimentId"
                WHERE variant.id = ${tokenMatchup.stealthVariantId}
                  AND variant.status = 'ACTIVE'
                  AND experiment.status = 'ACTIVE'
                  AND (
                    (variant."modelId" = ${tokenMatchup.modelAId} AND variant."modelId" <> ${tokenMatchup.modelBId}) OR
                    (variant."modelId" = ${tokenMatchup.modelBId} AND variant."modelId" <> ${tokenMatchup.modelAId})
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM "StealthVariant" other_variant
                    WHERE other_variant.id <> variant.id
                      AND other_variant."modelId" IN (${tokenMatchup.modelAId}, ${tokenMatchup.modelBId})
                  )
                FOR SHARE OF variant, experiment
              )`
            : Prisma.sql`NOT EXISTS (
                SELECT 1
                FROM "StealthVariant" variant
                WHERE variant."modelId" IN (${tokenMatchup.modelAId}, ${tokenMatchup.modelBId})
              )`
        }
      FOR SHARE OF build_a, build_b, model_a, model_b
    `;
    const [voteWrite] = await withArenaWriteRetry(async () => {
      return prisma.$queryRaw<Array<{
        validMatchup: boolean;
        voteId: string | null;
        userId: string | null;
      }>>(Prisma.sql`
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
            "samplingReason",
            "stealthVariantId"
          )
          SELECT
            ${dbMatchupId},
            ${matchup.promptId},
            ${matchup.modelAId},
            ${matchup.modelBId},
            ${matchup.buildAId},
            ${matchup.buildBId},
            ${matchup.samplingLane},
            ${matchup.samplingReason},
            ${matchup.stealthVariantId}
          FROM valid_matchup
          ON CONFLICT ("id") DO NOTHING
        ),
        inserted_vote AS (
          INSERT INTO "Vote" (
            "id",
            "matchupId",
            "sessionId",
            "choice",
            "userId"
          )
          SELECT ${voteId}, ${dbMatchupId}, ${sessionId}, ${choice}, ${voteOwnerSql}
          FROM valid_matchup
          ON CONFLICT ("matchupId", "sessionId") DO NOTHING
          RETURNING "id", "userId"
        ),
        inserted_job AS (
          INSERT INTO "ArenaVoteJob" (
            "id",
            "voteId",
            "matchupId",
            "promptId",
            "modelAId",
            "modelBId",
            "choice",
            "stealthVariantId"
          )
          SELECT
            ${jobId},
            "id",
            ${dbMatchupId},
            ${matchup.promptId},
            ${matchup.modelAId},
            ${matchup.modelBId},
            ${choice},
            ${matchup.stealthVariantId}
          FROM inserted_vote
          RETURNING "voteId"
        )
        SELECT
          EXISTS (SELECT 1 FROM valid_matchup) AS "validMatchup",
          (SELECT "voteId" FROM inserted_job LIMIT 1) AS "voteId",
          (SELECT "userId" FROM inserted_vote LIMIT 1) AS "userId"
      `);
    });
    timing.end("tx", txStartedAt);
    if (!voteWrite?.validMatchup) {
      return respondJson({ error: "Matchup is no longer active" }, { status: 409 });
    }

    queuedVoteJobs = voteWrite.voteId ? 1 : 0;
    logArenaVoteRequest(req, {
      outcome: voteWrite.voteId ? "accepted" : "duplicate",
      voteId: voteWrite.voteId,
      choice,
      authenticated: Boolean(authUserId),
      owned: Boolean(voteWrite.userId),
      scope: matchup.stealthVariantId ? "private" : "public",
    });
    if (queuedVoteJobs > 0) {
      queuedVoteJobInput = {
        voteJobId: jobId,
        promptId: matchup.promptId,
        modelAId: matchup.modelAId,
        modelBId: matchup.modelBId,
        choice,
        ...(matchup.stealthVariantId ? { stealthVariantId: matchup.stealthVariantId } : {}),
      };
    }

    const responseBody: ArenaVoteResponse = {
      ok: true,
      reveal,
    };
    res = NextResponse.json(responseBody, { headers: { "Cache-Control": "no-store" } });
    if (session.cookieValue) {
      res.cookies.set(
        ARENA_SESSION_COOKIE,
        session.cookieValue,
        ARENA_SESSION_COOKIE_OPTIONS,
      );
    }
  } catch (err) {
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
  if (queuedVoteJobInput && !queuedVoteJobInput.stealthVariantId) {
    recordArenaVoteQueuedForSampling(queuedVoteJobInput);
  } else if (queuedVoteJobInput?.stealthVariantId) {
    invalidateStealthSamplingCache();
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
