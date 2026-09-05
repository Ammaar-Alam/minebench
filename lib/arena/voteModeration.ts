import { Prisma } from "@prisma/client";
import { ARENA_COVERAGE_LOCK_KEY, ARENA_VOTE_JOB_DRAIN_LOCK_KEY } from "@/lib/arena/advisoryLocks";
import { invalidateArenaCoverageCache } from "@/lib/arena/coverage";
import { invalidateArenaStatsCache } from "@/lib/arena/stats";
import { GalleryServiceError, requireMineBenchAdmin } from "@/lib/gallery/service";
import { prisma } from "@/lib/prisma";
import { PUBLIC_SESSION_RETENTION_MS } from "@/lib/publicPresence";
import { hashVoteSession } from "@/lib/voteBlock";

const MAX_VOTE_IDS = 1_000;
const MAX_TEXT_ID_LENGTH = 191;
const VALID_CHOICES = new Set(["A", "B", "TIE", "BOTH_BAD"]);

type SelectedVoteRow = { id: string; sessionId: string; choice: string; stealthVariantId: string | null };
type MutationCountRow = { expected: number; updated: number };

function fail(code: string, message: string): never {
  throw new GalleryServiceError(code, message);
}

function validateVoteRemovalInput(adminId: string, sessionId: string, voteIds: string[]): string[] {
  if (!adminId) fail("forbidden", "MineBench admin access required.");
  if (!sessionId || sessionId.length > MAX_TEXT_ID_LENGTH) fail("invalid_request", "Vote session is required.");
  if (!Array.isArray(voteIds) || voteIds.length === 0) fail("invalid_request", "Select at least one arena vote to remove.");
  if (voteIds.length > MAX_VOTE_IDS) fail("invalid_request", `Remove at most ${MAX_VOTE_IDS} arena votes at a time.`);

  const seen = new Set<string>();
  for (const id of voteIds) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_TEXT_ID_LENGTH) {
      fail("invalid_request", "Vote IDs must be nonempty strings.");
    }
    if (seen.has(id)) fail("invalid_request", "Vote IDs must be unique.");
    seen.add(id);
  }
  return [...voteIds];
}

function assertValidSelection(rows: SelectedVoteRow[], voteIds: string[], sessionId: string) {
  const found = new Set(rows.map((row) => row.id));
  if (
    rows.length !== voteIds.length ||
    voteIds.some((id) => !found.has(id)) ||
    rows.some((row) => row.sessionId !== sessionId || row.stealthVariantId)
  ) {
    fail("not_found", "Vote selection does not match the reviewed public session.");
  }
  if (rows.some((row) => !VALID_CHOICES.has(row.choice))) {
    fail("invalid_request", "Unsupported arena vote choice.");
  }
}

async function assertMutation(tx: Prisma.TransactionClient, sql: Prisma.Sql, message: string) {
  const [result] = await tx.$queryRaw<MutationCountRow[]>(sql);
  if (Number(result?.updated ?? 0) !== Number(result?.expected ?? 0)) fail("conflict", message);
}

async function lockReviewedVotes(tx: Prisma.TransactionClient, idList: Prisma.Sql, voteIds: string[], sessionId: string) {
  const rows = await tx.$queryRaw<SelectedVoteRow[]>(Prisma.sql`
    SELECT vote.id, vote."sessionId", vote.choice, matchup."stealthVariantId"
    FROM "Vote" vote
    INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
    WHERE vote.id IN (${idList})
    ORDER BY vote.id ASC
    FOR UPDATE OF vote, matchup
  `);
  assertValidSelection(rows, voteIds, sessionId);

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT job.id
    FROM "ArenaVoteJob" job
    WHERE job."voteId" IN (${idList})
    ORDER BY job.id ASC
    FOR UPDATE OF job
  `);
}

async function reverseAppliedCounters(tx: Prisma.TransactionClient, idList: Prisma.Sql) {
  await assertMutation(
    tx,
    Prisma.sql`
      WITH applied_votes AS (
        SELECT vote.choice, matchup."modelAId", matchup."modelBId"
        FROM "Vote" vote
        INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
        LEFT JOIN "ArenaVoteJob" job ON job."voteId" = vote.id
        WHERE vote.id IN (${idList}) AND (job.id IS NULL OR job."processedAt" IS NOT NULL)
      ),
      counter_deltas AS (
        SELECT "modelId", SUM("win")::int AS "winCount", SUM("loss")::int AS "lossCount",
          SUM("draw")::int AS "drawCount", SUM("bothBad")::int AS "bothBadCount"
        FROM (
          SELECT "modelAId" AS "modelId", (choice = 'A')::int AS "win", (choice = 'B')::int AS "loss",
            (choice = 'TIE')::int AS "draw", (choice = 'BOTH_BAD')::int AS "bothBad"
          FROM applied_votes
          UNION ALL
          SELECT "modelBId" AS "modelId", (choice = 'B')::int AS "win", (choice = 'A')::int AS "loss",
            (choice = 'TIE')::int AS "draw", (choice = 'BOTH_BAD')::int AS "bothBad"
          FROM applied_votes
        ) rows GROUP BY "modelId"
        HAVING SUM("win" + "loss" + "draw" + "bothBad") > 0
      ),
      updated AS (
        UPDATE "Model" AS model
        SET "winCount" = model."winCount" - delta."winCount", "lossCount" = model."lossCount" - delta."lossCount",
          "drawCount" = model."drawCount" - delta."drawCount", "bothBadCount" = model."bothBadCount" - delta."bothBadCount",
          "updatedAt" = CURRENT_TIMESTAMP
        FROM counter_deltas delta
        WHERE model.id = delta."modelId" AND model."winCount" >= delta."winCount"
          AND model."lossCount" >= delta."lossCount" AND model."drawCount" >= delta."drawCount"
          AND model."bothBadCount" >= delta."bothBadCount"
        RETURNING 1
      )
      SELECT (SELECT COUNT(*)::int FROM counter_deltas) AS expected,
        (SELECT COUNT(*)::int FROM updated) AS updated
    `,
    "Arena vote counters are lower than the applied removal.",
  );
}

async function reverseAppliedCoverage(tx: Prisma.TransactionClient, idList: Prisma.Sql) {
  await assertMutation(
    tx,
    Prisma.sql`
      WITH decisive_votes AS (
        SELECT matchup."promptId", matchup."modelAId", matchup."modelBId"
        FROM "Vote" vote
        INNER JOIN "Matchup" matchup ON matchup.id = vote."matchupId"
        LEFT JOIN "ArenaVoteJob" job ON job."voteId" = vote.id
        WHERE vote.id IN (${idList}) AND vote.choice IN ('A', 'B')
          AND (job.id IS NULL OR job."processedAt" IS NOT NULL)
      ),
      model_prompt_deltas AS (
        SELECT "modelId", "promptId", COUNT(*)::int AS count
        FROM (
          SELECT "modelAId" AS "modelId", "promptId" FROM decisive_votes
          UNION ALL SELECT "modelBId" AS "modelId", "promptId" FROM decisive_votes
        ) rows GROUP BY "modelId", "promptId"
      ),
      pair_deltas AS (
        SELECT LEAST("modelAId", "modelBId") AS "modelLowId", GREATEST("modelAId", "modelBId") AS "modelHighId",
          COUNT(*)::int AS count FROM decisive_votes GROUP BY 1, 2
      ),
      pair_prompt_deltas AS (
        SELECT LEAST("modelAId", "modelBId") AS "modelLowId", GREATEST("modelAId", "modelBId") AS "modelHighId",
          "promptId", COUNT(*)::int AS count FROM decisive_votes GROUP BY 1, 2, "promptId"
      ),
      updated_model_prompt AS (
        UPDATE "ArenaCoverageModelPrompt" AS coverage
        SET "decisiveVotes" = coverage."decisiveVotes" - delta.count
        FROM model_prompt_deltas delta
        WHERE coverage."modelId" = delta."modelId" AND coverage."promptId" = delta."promptId"
          AND coverage."decisiveVotes" > delta.count
        RETURNING 1
      ),
      deleted_zero_model_prompt AS (
        DELETE FROM "ArenaCoverageModelPrompt" coverage
        USING model_prompt_deltas delta
        WHERE coverage."modelId" = delta."modelId" AND coverage."promptId" = delta."promptId"
          AND coverage."decisiveVotes" = delta.count
        RETURNING 1
      ),
      updated_pair AS (
        UPDATE "ArenaCoveragePair" AS coverage
        SET "decisiveVotes" = coverage."decisiveVotes" - delta.count
        FROM pair_deltas delta
        WHERE coverage."modelLowId" = delta."modelLowId" AND coverage."modelHighId" = delta."modelHighId"
          AND coverage."decisiveVotes" > delta.count
        RETURNING 1
      ),
      deleted_zero_pair AS (
        DELETE FROM "ArenaCoveragePair" coverage
        USING pair_deltas delta
        WHERE coverage."modelLowId" = delta."modelLowId" AND coverage."modelHighId" = delta."modelHighId"
          AND coverage."decisiveVotes" = delta.count
        RETURNING 1
      ),
      updated_pair_prompt AS (
        UPDATE "ArenaCoveragePairPrompt" AS coverage
        SET "decisiveVotes" = coverage."decisiveVotes" - delta.count
        FROM pair_prompt_deltas delta
        WHERE coverage."modelLowId" = delta."modelLowId" AND coverage."modelHighId" = delta."modelHighId"
          AND coverage."promptId" = delta."promptId"
          AND coverage."decisiveVotes" > delta.count
        RETURNING 1
      ),
      deleted_zero_pair_prompt AS (
        DELETE FROM "ArenaCoveragePairPrompt" coverage
        USING pair_prompt_deltas delta
        WHERE coverage."modelLowId" = delta."modelLowId" AND coverage."modelHighId" = delta."modelHighId"
          AND coverage."promptId" = delta."promptId"
          AND coverage."decisiveVotes" = delta.count
        RETURNING 1
      )
      SELECT (
          (SELECT COUNT(*) FROM model_prompt_deltas) + (SELECT COUNT(*) FROM pair_deltas) +
          (SELECT COUNT(*) FROM pair_prompt_deltas)
        )::int AS expected,
        (
          (SELECT COUNT(*) FROM updated_model_prompt) + (SELECT COUNT(*) FROM deleted_zero_model_prompt) +
          (SELECT COUNT(*) FROM updated_pair) + (SELECT COUNT(*) FROM deleted_zero_pair) +
          (SELECT COUNT(*) FROM updated_pair_prompt) + (SELECT COUNT(*) FROM deleted_zero_pair_prompt)
        )::int AS updated
    `,
    "Arena coverage is lower than the applied removal.",
  );
}

export async function removePublicArenaVotes(adminId: string, sessionId: string, voteIds: string[]): Promise<{ removed: number }> {
  const reviewedVoteIds = validateVoteRemovalInput(adminId, sessionId, voteIds);
  await requireMineBenchAdmin(adminId);

  const idList = Prisma.join(reviewedVoteIds);
  const sessionHash = hashVoteSession(sessionId);
  const removed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ARENA_COVERAGE_LOCK_KEY})`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ARENA_VOTE_JOB_DRAIN_LOCK_KEY})`;
    await lockReviewedVotes(tx, idList, reviewedVoteIds, sessionId);
    await reverseAppliedCounters(tx, idList);
    await reverseAppliedCoverage(tx, idList);

    await tx.galleryModerationRecord.create({
      data: {
        kind: "ADMIN_ACTION",
        target: "VOTE_BLOCK",
        action: "arena_votes_removed",
        actorUserId: adminId,
        sessionHash,
        note: `Removed ${reviewedVoteIds.length} public arena vote${reviewedVoteIds.length === 1 ? "" : "s"}.`,
        safeSnapshot: { voteIds: reviewedVoteIds, removed: reviewedVoteIds.length },
        purgeAt: new Date(Date.now() + PUBLIC_SESSION_RETENTION_MS),
      },
    });

    const deleted = await tx.vote.deleteMany({ where: { id: { in: reviewedVoteIds } } });
    if (deleted.count !== reviewedVoteIds.length) fail("conflict", "Vote selection changed during removal.");

    const remainingJobs = await tx.arenaVoteJob.count({ where: { voteId: { in: reviewedVoteIds } } });
    if (remainingJobs !== 0) fail("conflict", "Arena vote jobs were not removed.");
    return deleted.count;
  }, { maxWait: 5_000, timeout: 15_000 });

  invalidateArenaCoverageCache();
  invalidateArenaStatsCache();
  return { removed };
}
