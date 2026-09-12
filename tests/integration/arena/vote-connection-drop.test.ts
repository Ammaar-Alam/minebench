import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { POST as vote } from "../../../app/api/arena/vote/route";
import { createArenaMatchupToken } from "../../../lib/arena/matchupToken";
import { ARENA_WRITE_RETRY_MAX_ATTEMPTS } from "../../../lib/arena/writeRetry";
import { ARENA_SESSION_COOKIE, readArenaSessionId } from "../../../lib/arena/session";
import { prisma as routePrisma } from "../../../lib/prisma";

const db = new PrismaClient();

function prismaKnownError(code: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "6.0.0" });
}

async function main() {
  const schema = process.env.MINEBENCH_TEST_SCHEMA;
  if (!schema) {
    console.log("arena vote connection-drop integration checks require pnpm test:integration");
    return;
  }

  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const prompt = await db.prompt.create({
    data: { text: `Vote connection drop ${suffix}`, active: true },
  });
  const modelA = await db.model.create({
    data: {
      key: `vcd-a-${suffix}`,
      provider: "Test",
      modelId: `vcd-a-${suffix}`,
      displayName: `VCD A ${suffix}`,
    },
  });
  const modelB = await db.model.create({
    data: {
      key: `vcd-b-${suffix}`,
      provider: "Test",
      modelId: `vcd-b-${suffix}`,
      displayName: `VCD B ${suffix}`,
    },
  });
  const checksumA = "a".repeat(64);
  const checksumB = "b".repeat(64);
  const buildA = await db.build.create({
    data: {
      promptId: prompt.id,
      modelId: modelA.id,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      voxelSha256: checksumA,
      blockCount: 1,
      generationTimeMs: 1,
    },
  });
  const buildB = await db.build.create({
    data: {
      promptId: prompt.id,
      modelId: modelB.id,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      voxelSha256: checksumB,
      blockCount: 1,
      generationTimeMs: 1,
    },
  });

  const originalSigningSecret = process.env.ARENA_MATCHUP_SIGNING_SECRET;
  const originalDrainSetting = process.env.ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE;
  process.env.ARENA_MATCHUP_SIGNING_SECRET = "vcd-integration-secret";
  process.env.ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE = "0";
  try {
    const signedMatchupId = createArenaMatchupToken({
      promptId: prompt.id,
      modelAId: modelA.id,
      modelBId: modelB.id,
      buildAId: buildA.id,
      buildBId: buildB.id,
      buildAChecksum: checksumA,
      buildBChecksum: checksumB,
    });
    const voteRequest = () =>
      new Request("http://localhost:3000/api/arena/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ matchupId: signedMatchupId, choice: "A" }),
      });

    const queryRawHost = routePrisma as unknown as { $queryRaw: unknown };
    const originalQueryRaw = queryRawHost.$queryRaw;

    try {
      // A transient connection drop (P1017) during the atomic vote write must be
      // retried up to MAX_ATTEMPTS and then surfaced as 503 + Retry-After, never
      // 409. No vote is committed while every attempt fails.
      const p1017 = prismaKnownError("P1017", "Server has closed the connection.");
      let dropCalls = 0;
      queryRawHost.$queryRaw = () => {
        dropCalls += 1;
        throw p1017;
      };
      const dropped = await vote(voteRequest());
      assert.equal(
        dropped.status,
        503,
        `connection drop must surface as 503 (got ${dropped.status})`,
      );
      assert.equal(
        dropped.headers.get("retry-after"),
        "1",
        "connection-drop 503 must include Retry-After: 1",
      );
      assert.equal(
        dropCalls,
        ARENA_WRITE_RETRY_MAX_ATTEMPTS,
        `write must be retried ${ARENA_WRITE_RETRY_MAX_ATTEMPTS}x before surfacing 503`,
      );
      assert.equal(await db.vote.count(), 0, "no vote may be committed while every attempt fails");
    } finally {
      queryRawHost.$queryRaw = originalQueryRaw;
    }

    // After the drop clears, the same matchup token must succeed exactly once —
    // the failed attempts must not have produced a duplicate or partial commit.
    const accepted = await vote(voteRequest());
    assert.equal(
      accepted.status,
      200,
      `happy-path vote after a transient drop must succeed (got ${accepted.status}: ${JSON.stringify(await accepted.json())})`,
    );
    assert.equal(await db.vote.count(), 1, "exactly one vote must be committed after recovery");
    assert.equal(await db.arenaVoteJob.count(), 1, "exactly one arena vote job must be queued");

    // A retry from the SAME session (carrying the session cookie the route just
    // minted) is idempotent via ON CONFLICT ("matchupId","sessionId") DO NOTHING
    // — this is the property that makes withArenaWriteRetry's retries safe.
    const setCookie = accepted.headers.get("set-cookie");
    const sessionId = setCookie ? readArenaSessionId(setCookie) : null;
    assert.ok(sessionId, "the accepted vote must mint a session cookie for the duplicate retry");
    const duplicateRequest = () =>
      new Request("http://localhost:3000/api/arena/vote", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${ARENA_SESSION_COOKIE}=${sessionId}`,
        },
        body: JSON.stringify({ matchupId: signedMatchupId, choice: "A" }),
      });
    const duplicate = await vote(duplicateRequest());
    assert.equal(duplicate.status, 200);
    assert.equal(await db.vote.count(), 1, "a retry of the same session/matchup must not duplicate the vote");
    assert.equal(await db.arenaVoteJob.count(), 1, "a retry must not queue a second job");

    // A genuine non-capacity error (unique constraint P2002 raised outside the
    // idempotent ON CONFLICT path) surfaces as 409 with no Retry-After and is
    // not retried — guarding the capacity/conflict status split.
    const p2002 = prismaKnownError("P2002", "Unique constraint failed");
    let conflictCalls = 0;
    let conflictThrew = false;
    queryRawHost.$queryRaw = () => {
      conflictCalls += 1;
      conflictThrew = true;
      throw p2002;
    };
    try {
      const conflict = await vote(voteRequest());
      assert.equal(
        conflict.status,
        409,
        `non-capacity write error must surface as 409 (got ${conflict.status})`,
      );
      assert.equal(
        conflict.headers.get("retry-after"),
        null,
        "409 conflict must not include Retry-After",
      );
      assert.equal(conflictCalls, 1, "non-capacity write errors must not be retried");
      assert.ok(conflictThrew, "the conflict branch must reach the write, not short-circuit");
    } finally {
      queryRawHost.$queryRaw = originalQueryRaw;
    }
    assert.equal(await db.vote.count(), 1, "a failed write must not change committed vote count");

    console.log("arena vote connection-drop integration checks passed");
  } finally {
    if (originalSigningSecret === undefined) delete process.env.ARENA_MATCHUP_SIGNING_SECRET;
    else process.env.ARENA_MATCHUP_SIGNING_SECRET = originalSigningSecret;
    if (originalDrainSetting === undefined) delete process.env.ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE;
    else process.env.ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE = originalDrainSetting;
    // Remove all records seeded by this test so that subsequent integration tests
    // (e.g. stealth/database-boundaries) start with a clean schema-wide vote count.
    const matchups = await db.matchup.findMany({
      where: { promptId: prompt.id },
      select: { id: true },
    });
    const matchupIds = matchups.map((m) => m.id);
    if (matchupIds.length > 0) {
      await db.vote.deleteMany({ where: { matchupId: { in: matchupIds } } });
      await db.matchup.deleteMany({ where: { id: { in: matchupIds } } });
    }
    await db.build.deleteMany({ where: { promptId: prompt.id } });
    await db.model.deleteMany({ where: { id: { in: [modelA.id, modelB.id] } } });
    await db.prompt.delete({ where: { id: prompt.id } });
  }
}

main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
