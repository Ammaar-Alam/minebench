import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

import {
  ARENA_WRITE_RETRY_MAX_ATTEMPTS,
  isArenaCapacityError,
  withArenaWriteRetry,
} from "../../../lib/arena/writeRetry";
import { isDatabaseUnavailableError } from "../../../lib/db/errors";
import { createArenaMatchupToken } from "../../../lib/arena/matchupToken";
import { prisma as routePrisma } from "../../../lib/prisma";
import { POST } from "../../../app/api/arena/vote/route";

function prismaKnownError(code: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "6.0.0" });
}

const read = (path: string) => readFileSync(path, "utf8");

// The connection-unavailability family (P1017/P1001/P1002/P1008/P2024) is what
// the read path already classifies via isDatabaseUnavailableError; the write
// path's isArenaCapacityError must agree so transient drops are retried and
// surfaced as 503 rather than a permanent 409.
const CONNECTION_DROP_CODES = ["P1017", "P1001", "P1002", "P1008", "P2024"] as const;
for (const code of CONNECTION_DROP_CODES) {
  const error = prismaKnownError(code, "Server has closed the connection.");
  assert.equal(
    isArenaCapacityError(error),
    true,
    `Prisma ${code} must be a retryable arena capacity error after the fix`,
  );
  assert.equal(
    isDatabaseUnavailableError(error),
    true,
    `Prisma ${code} must remain a database-unavailable error`,
  );
}

// The plain-Error-with-code idiom (used in tests/unit/db-errors.test.ts) is
// caught too, because isDatabaseUnavailableError reads error.code generically.
assert.equal(
  isArenaCapacityError(
    Object.assign(new Error("Server has closed the connection."), { code: "P1017" }),
  ),
  true,
);
assert.equal(
  isArenaCapacityError(
    Object.assign(new Error("Can't reach database server"), { code: "P1001" }),
  ),
  true,
);
// Connection-unavailability message patterns flow through the shared classifier.
for (const message of ["Can't reach database server", "Failed to connect to database"]) {
  assert.equal(
    isArenaCapacityError(new Error(message)),
    true,
    `connection-unavailable message "${message}" must be retryable via the shared classifier`,
  );
}

// No regression on the lock / transaction-conflict codes that were already covered.
for (const code of ["P2034", "P2028"] as const) {
  assert.equal(
    isArenaCapacityError(prismaKnownError(code, "transaction conflict")),
    true,
    `Prisma lock/tx code ${code} must remain retryable`,
  );
}

// No regression on the message-substring capacity / lock checks.
const capacityMessages = [
  "deadlock detected",
  "could not obtain lock on resource",
  "could not serialize access due to concurrent update",
  "serialization failure",
  "timed out fetching a new connection from the pool",
  "connection pool exhausted",
  "too many connections",
  "write conflict",
  "arena optimistic model conflict",
];
for (const message of capacityMessages) {
  assert.equal(
    isArenaCapacityError(new Error(message)),
    true,
    `capacity message "${message}" must remain retryable`,
  );
}

// Non-capacity errors must stay non-retryable so genuine conflicts still map to 409.
assert.equal(isArenaCapacityError(new Error("Unique constraint failed")), false);
assert.equal(isArenaCapacityError(prismaKnownError("P2002", "Unique constraint failed")), false);
assert.equal(isArenaCapacityError(new Error("Record to update not found")), false);
assert.equal(isArenaCapacityError(null), false);
assert.equal(isArenaCapacityError(undefined), false);
assert.equal(isArenaCapacityError("some string"), false);

// Source-text contracts that lock the fix and the status wiring in place.
const writeRetrySource = read("lib/arena/writeRetry.ts");
assert.match(writeRetrySource, /import \{ isDatabaseUnavailableError \} from "@\/lib\/db\/errors";/);
assert.match(
  writeRetrySource,
  /if \(isDatabaseUnavailableError\(error\)\) return true;/,
  "isArenaCapacityError must delegate connection-unavailability to the shared classifier",
);

const voteRouteSource = read("app/api/arena/vote/route.ts");
assert.match(
  voteRouteSource,
  /return isArenaCapacityError\(error\)/,
  "vote route capacity status must derive from isArenaCapacityError",
);
assert.match(
  voteRouteSource,
  /status: capacityError \? 503 : 409/,
  "vote route must map capacity errors to 503 and conflicts to 409",
);
assert.match(
  voteRouteSource,
  /headers: capacityError \? \{ "Retry-After": "1" \} : undefined/,
  "vote route must send Retry-After only on the capacity (503) branch",
);

const matchupRouteSource = read("app/api/arena/matchup/route.ts");
assert.match(
  matchupRouteSource,
  /isDatabaseUnavailableError\(error\)/,
  "matchup read path must classify connection drops via isDatabaseUnavailableError",
);
assert.match(matchupRouteSource, /databaseUnavailableHeaders\(\)/);

async function expectEqual<T>(
  promise: Promise<T>,
  expected: unknown,
  message: string,
): Promise<void> {
  let thrown: unknown = new Error("withArenaWriteRetry was expected to throw but resolved");
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  assert.equal(thrown, expected, message);
}

async function main() {
  // A persistent connection drop is retried up to MAX_ATTEMPTS, then rethrown.
  // Before the fix, withArenaWriteRetry did not retry P1017 at all (1 call).
  const p1017 = prismaKnownError("P1017", "Server has closed the connection.");
  {
    let calls = 0;
    await expectEqual(
      withArenaWriteRetry(async () => {
        calls += 1;
        throw p1017;
      }),
      p1017,
      "withArenaWriteRetry must rethrow the connection-drop error after exhausting retries",
    );
    assert.equal(
      calls,
      ARENA_WRITE_RETRY_MAX_ATTEMPTS,
      "a connection drop must be retried up to ARENA_WRITE_RETRY_MAX_ATTEMPTS",
    );
  }

  // A transient connection drop that clears on the next attempt succeeds.
  {
    let calls = 0;
    const result = await withArenaWriteRetry(async () => {
      calls += 1;
      if (calls === 1) throw p1017;
      return "vote-committed";
    });
    assert.equal(result, "vote-committed");
    assert.equal(calls, 2, "a transient drop must be retried exactly once before succeeding");
  }

  // A non-capacity error is not retried and is rethrown unchanged.
  const p2002 = prismaKnownError("P2002", "Unique constraint failed");
  {
    let calls = 0;
    await expectEqual(
      withArenaWriteRetry(async () => {
        calls += 1;
        throw p2002;
      }),
      p2002,
      "a non-capacity error must be rethrown unchanged",
    );
    assert.equal(calls, 1, "non-capacity write errors must not be retried");
  }

  // P2034 lock/transaction conflicts are still retried (regression guard).
  const p2034 = prismaKnownError(
    "P2034",
    "Transaction failed due to a write conflict or deadlock",
  );
  {
    let calls = 0;
    await expectEqual(
      withArenaWriteRetry(async () => {
        calls += 1;
        throw p2034;
      }),
      p2034,
      "P2034 must be rethrown after exhausting retries",
    );
    assert.equal(
      calls,
      ARENA_WRITE_RETRY_MAX_ATTEMPTS,
      "P2034 lock conflicts must still be retried up to MAX_ATTEMPTS",
    );
  }

  // End-to-end: the vote route surfaces a connection drop as 503 + Retry-After
  // (with the write retried), while a genuine conflict stays a non-retried 409.
  const originalSigningSecret = process.env.ARENA_MATCHUP_SIGNING_SECRET;
  const originalDrainSetting = process.env.ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE;
  process.env.ARENA_MATCHUP_SIGNING_SECRET = "write-retry-test-secret";
  process.env.ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE = "0";
  try {
    const modelAId = crypto.randomUUID();
    const modelBId = crypto.randomUUID();
    const signedMatchupId = createArenaMatchupToken({
      promptId: crypto.randomUUID(),
      modelAId,
      modelBId,
      buildAId: crypto.randomUUID(),
      buildBId: crypto.randomUUID(),
      buildAChecksum: "a".repeat(64),
      buildBChecksum: "b".repeat(64),
    });
    const voteRequest = () =>
      new Request("http://localhost:3000/api/arena/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ matchupId: signedMatchupId, choice: "A" }),
      });

    const modelDelegate = routePrisma.model as unknown as Record<string, unknown>;
    const blockDelegate = routePrisma.galleryVoteBlock as unknown as Record<string, unknown>;
    const queryRawHost = routePrisma as unknown as { $queryRaw: unknown };
    const originalFindMany = modelDelegate.findMany;
    const originalFindFirst = blockDelegate.findFirst;
    const originalQueryRaw = queryRawHost.$queryRaw;

    // The reveal lookup and the vote-block check must succeed so the failure is
    // isolated to the atomic write CTE that withArenaWriteRetry wraps.
    modelDelegate.findMany = async () => [
      {
        id: modelAId,
        key: "test-model-a",
        provider: "openai",
        displayName: "Model A",
        stealthVariant: null,
      },
      {
        id: modelBId,
        key: "test-model-b",
        provider: "openai",
        displayName: "Model B",
        stealthVariant: null,
      },
    ];
    blockDelegate.findFirst = async () => null;

    try {
      // Connection drop during the write -> 503 + Retry-After, retried.
      let dropCalls = 0;
      queryRawHost.$queryRaw = () => {
        dropCalls += 1;
        throw p1017;
      };
      const dropped = await POST(voteRequest());
      assert.equal(
        dropped.status,
        503,
        "a connection drop during the vote write must surface as 503, not 409",
      );
      assert.equal(
        dropped.headers.get("retry-after"),
        "1",
        "the 503 capacity response must include Retry-After",
      );
      assert.equal(
        dropCalls,
        ARENA_WRITE_RETRY_MAX_ATTEMPTS,
        "the vote write must be retried up to MAX_ATTEMPTS before surfacing 503",
      );
      const dropBody = (await dropped.json()) as { error?: string };
      assert.ok(
        typeof dropBody.error === "string" && dropBody.error.length > 0,
        "the 503 response must carry a JSON error body",
      );

      // Genuine conflict (unique constraint) -> 409, no Retry-After, not retried.
      let conflictCalls = 0;
      queryRawHost.$queryRaw = () => {
        conflictCalls += 1;
        throw p2002;
      };
      const conflict = await POST(voteRequest());
      assert.equal(
        conflict.status,
        409,
        "a non-capacity write error must surface as 409, not 503",
      );
      assert.equal(
        conflict.headers.get("retry-after"),
        null,
        "the 409 response must not include Retry-After",
      );
      assert.equal(conflictCalls, 1, "non-capacity write errors must not be retried");
    } finally {
      modelDelegate.findMany = originalFindMany;
      blockDelegate.findFirst = originalFindFirst;
      queryRawHost.$queryRaw = originalQueryRaw;
    }
  } finally {
    if (originalSigningSecret === undefined) delete process.env.ARENA_MATCHUP_SIGNING_SECRET;
    else process.env.ARENA_MATCHUP_SIGNING_SECRET = originalSigningSecret;
    if (originalDrainSetting === undefined) delete process.env.ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE;
    else process.env.ARENA_VOTE_JOB_DRAIN_AFTER_RESPONSE = originalDrainSetting;
  }

  console.log("arena write retry / connection-drop capacity checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
