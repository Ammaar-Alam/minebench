import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";

process.env.APNS_ENABLED = "true";
delete process.env.APNS_KEY_ID;
delete process.env.APNS_TEAM_ID;
delete process.env.APNS_PRIVATE_KEY;
delete process.env.EMAIL_NOTIFICATIONS_ENABLED;

const db = new PrismaClient();
(globalThis as unknown as { prisma?: PrismaClient }).prisma = db;

type PrismaTx = Prisma.TransactionClient;

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("notification concurrency PostgreSQL checks require pnpm test:integration");
    return;
  }

  const {
    enqueueGenerationNotification,
    lockNotificationAccounts,
  } = await import("../../lib/notifications/service");
  const { deleteMineBenchAccount } = await import("../../lib/account/service");
  const { failCustomBuildJob } = await import("../../lib/custom-builds/jobs");
  const { addGalleryExample, setGalleryVote } = await import("../../lib/gallery/service");
  const { prisma: appPrisma } = await import("../../lib/prisma");

  const suffix = randomUUID().replaceAll("-", "");
  let sequence = 0;
  const id = (label: string) => `${label}-${suffix}-${sequence++}`;
  const token = (label: string) => createHash("sha256").update(`${suffix}:${label}`).digest("hex");
  const now = new Date("2026-09-08T20:00:00.000Z");

  function errorText(error: unknown) {
    if (!(error instanceof Error)) return String(error);
    const details = error as Error & { code?: unknown; meta?: unknown };
    return `${error.name} ${String(details.code ?? "")} ${error.message} ${JSON.stringify(details.meta ?? {})}`;
  }

  function isDeadlock(error: unknown) {
    return /40P01|deadlock detected/i.test(errorText(error));
  }

  async function waitFor<T>(promise: Promise<T>, label: string, timeoutMs = 5_000) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function rawSqlText(queryArgs: unknown[]) {
    const first = queryArgs[0];
    if (first && typeof first === "object") {
      const query = first as { sql?: unknown; text?: unknown; strings?: unknown };
      if (typeof query.sql === "string") return query.sql;
      if (typeof query.text === "string") return query.text;
      if (Array.isArray(query.strings)) return query.strings.join(" ");
    }
    if (Array.isArray(first)) return first.join(" ");
    return String(first ?? "");
  }

  function assertRawSql(queryArgs: unknown[], pattern: RegExp, label: string) {
    const sql = rawSqlText(queryArgs).replace(/\s+/g, " ").trim();
    assert.match(sql, pattern, `${label} intercepted unexpected raw SQL: ${sql}`);
  }

  function wrapFirstQueryRaw(
    tx: PrismaTx,
    onFirstQuery: (queryArgs: unknown[], runQuery: () => Promise<unknown>) => Promise<unknown>,
  ) {
    let firstQuery = true;
    return new Proxy(tx as unknown as Record<PropertyKey, unknown>, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "$queryRaw" && typeof value === "function") {
          return (...queryArgs: unknown[]) => {
            if (!firstQuery) return value.apply(target, queryArgs);
            firstQuery = false;
            return onFirstQuery(queryArgs, () => Promise.resolve(value.apply(target, queryArgs)));
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as PrismaTx;
  }

  async function createUser(label: string) {
    const userId = randomUUID();
    await db.user.create({
      data: {
        id: userId,
        email: `${label}-${suffix}@example.test`,
      },
    });
    return userId;
  }

  async function createUserWithDevice(label: string) {
    const userId = await createUser(label);
    await db.pushDevice.create({
      data: { userId, token: token(label), environment: "development" },
    });
    return userId;
  }

  async function createBuild(
    userId: string,
    label: string,
    status: "queued" | "running" | "succeeded" | "failed" = "running",
    data: Partial<Prisma.CustomBuildUncheckedCreateInput> = {},
  ) {
    return db.customBuild.create({
      data: {
        id: id(`build-${label}`),
        publicId: `cb_${suffix}_${label}_${sequence++}`,
        ownerId: userId,
        status,
        currentStage: status,
        completedAt: status === "succeeded" || status === "failed" ? now : null,
        promptText: `Notification concurrency ${label}`,
        promptSha256: createHash("sha256").update(`${suffix}:${label}`).digest("hex"),
        gridSize: 64,
        palette: "simple",
        modelKind: "catalog",
        modelProvider: "openai",
        modelId: "gpt-5.4-mini",
        modelDisplayName: "GPT 5.4 Mini",
        ...data,
      },
    });
  }

  async function createGalleryBuild(userId: string, promptText: string, label: string) {
    return createBuild(userId, label, "succeeded", {
      promptText,
      artifacts: {
        create: {
          kind: "build_json",
          format: "json.gz",
          bucket: "builds",
          path: `notification-concurrency/${suffix}/${label}.json.gz`,
          contentType: "application/gzip",
          fileName: `${label}.json.gz`,
          sha256: createHash("sha256").update(`${suffix}:${label}:artifact`).digest("hex"),
          byteSize: 12,
          storedByteSize: 12,
        },
      },
    });
  }

  async function createCandidate(userId: string, label: string) {
    return db.galleryCandidate.create({
      data: {
        publicId: `gal_${suffix}_${label}`,
        promptText: `Gallery concurrency ${label} ${suffix}`,
        promptKey: `gallery-concurrency-${label}-${suffix}`,
        uploaderId: userId,
      },
    });
  }

  async function assertAccountDeleted(label: string, ownerId: string) {
    const deletedAccount = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
    assert.ok(deletedAccount.deletedAt, `${label} should delete the account`);
    assert.equal(
      await db.notificationDelivery.count({ where: { userId: ownerId } }),
      0,
      `${label} should leave no notification deliveries for the deleted account`,
    );
  }

  async function runServiceDeletionRace(
    label: string,
    ownerId: string,
    operation: () => Promise<unknown>,
  ) {
    const transactionPrisma = appPrisma as unknown as {
      $transaction: typeof appPrisma.$transaction;
    };
    const originalTransaction = transactionPrisma.$transaction;
    const runOriginalTransaction = originalTransaction as unknown as (...args: unknown[]) => Promise<unknown>;
    let releaseOperation: () => void = () => {};
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let markAccountLocked: () => void = () => {};
    const accountLocked = new Promise<void>((resolve) => {
      markAccountLocked = resolve;
    });
    let markDeleteQueryStarted: () => void = () => {};
    const deleteQueryStarted = new Promise<void>((resolve) => {
      markDeleteQueryStarted = resolve;
    });
    let functionTransactions = 0;
    transactionPrisma.$transaction = ((input: unknown, ...args: unknown[]) => {
      if (typeof input !== "function") {
        return runOriginalTransaction.apply(appPrisma, [input, ...args]);
      }
      functionTransactions += 1;
      if (functionTransactions === 1) {
        return runOriginalTransaction.apply(appPrisma, [
          async (tx: PrismaTx) => {
            const wrappedTx = wrapFirstQueryRaw(tx, async (queryArgs, runQuery) => {
              assertRawSql(queryArgs, /SELECT id FROM "User".*FOR KEY SHARE/i, label);
              const result = await runQuery();
              markAccountLocked();
              await operationGate;
              return result;
            });
            return (input as (tx: PrismaTx) => Promise<unknown>)(wrappedTx);
          },
          ...args,
        ]);
      }
      if (functionTransactions === 2) {
        return runOriginalTransaction.apply(appPrisma, [
          async (tx: PrismaTx) => {
            const wrappedTx = wrapFirstQueryRaw(tx, async (queryArgs, runQuery) => {
              assertRawSql(queryArgs, /SELECT id, email FROM "User".*FOR UPDATE/i, label);
              markDeleteQueryStarted();
              return runQuery();
            });
            return (input as (tx: PrismaTx) => Promise<unknown>)(wrappedTx);
          },
          ...args,
        ]);
      }
      return runOriginalTransaction.apply(appPrisma, [input, ...args]);
    }) as unknown as typeof originalTransaction;

    let operationPromise: Promise<unknown> | undefined;
    let deletionPromise: Promise<unknown> | undefined;
    try {
      operationPromise = operation();
      await waitFor(
        Promise.race([
          accountLocked,
          operationPromise.then(
            () => {
              throw new Error(`${label} operation finished before notification account lock`);
            },
            (error) => {
              throw error;
            },
          ),
        ]),
        `${label} notification account lock`,
      );

      let authDeletionCalls = 0;
      deletionPromise = deleteMineBenchAccount(ownerId, {
        now,
        deleteAuthUser: async () => {
          authDeletionCalls += 1;
        },
      });
      await waitFor(deleteQueryStarted, `${label} account deletion lock attempt`);
      releaseOperation();

      const [operationResult, deletionResult] = await waitFor(
        Promise.allSettled([operationPromise, deletionPromise]),
        `${label} deletion race`,
      );
      if (operationResult.status === "rejected") {
        assert.equal(isDeadlock(operationResult.reason), false, errorText(operationResult.reason));
        throw operationResult.reason;
      }
      if (deletionResult.status === "rejected") {
        assert.equal(isDeadlock(deletionResult.reason), false, errorText(deletionResult.reason));
        throw deletionResult.reason;
      }
      assert.equal(authDeletionCalls, 1, `${label} should delete Supabase Auth once`);
    } finally {
      releaseOperation();
      transactionPrisma.$transaction = originalTransaction;
      await Promise.allSettled([operationPromise, deletionPromise].filter(Boolean));
    }

    await assertAccountDeleted(label, ownerId);
  }

  try {
    const successOwnerId = await createUserWithDevice("notification-concurrency-success");
    const successBuild = await createBuild(successOwnerId, "success", "running");
    await runServiceDeletionRace("generation success", successOwnerId, async () => {
      await db.$transaction(async (tx) => {
        await lockNotificationAccounts(tx, [successOwnerId]);
        const completed = await tx.customBuild.updateMany({
          where: { id: successBuild.id, removedAt: null, status: "running" },
          data: { status: "succeeded", currentStage: "complete", completedAt: now },
        });
        assert.equal(completed.count, 1);
        await enqueueGenerationNotification(tx, successBuild.id);
      });
    });

    const failureOwnerId = await createUserWithDevice("notification-concurrency-failure");
    const failureBuild = await createBuild(failureOwnerId, "failure", "running");
    const failureJob = await db.customBuildJob.create({
      data: {
        customBuildId: failureBuild.id,
        type: "generate",
        status: "running",
        attempts: 1,
        maxAttempts: 1,
        lockedBy: "worker-a",
        lockedAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
    });
    await runServiceDeletionRace("generation failure", failureOwnerId, async () => {
      const result = await failCustomBuildJob(
        failureJob.id,
        "worker-a",
        { code: "provider_failed", message: "Provider failed." },
        appPrisma,
        { forceTerminal: true },
      );
      assert.deepEqual(result, { requeued: false });
    });

    const contributionOwnerId = await createUserWithDevice("notification-concurrency-contribution-owner");
    const contributorId = await createUser("notification-concurrency-contributor");
    const contributionCandidate = await createCandidate(contributionOwnerId, "contribution");
    const contributionBuild = await createGalleryBuild(
      contributorId,
      contributionCandidate.promptText,
      "contribution-build",
    );
    await runServiceDeletionRace("gallery contribution", contributionOwnerId, async () => {
      const result = await addGalleryExample(contributorId, contributionCandidate.publicId, {
        generationId: contributionBuild.publicId,
        postAnonymously: true,
      });
      assert.equal(result.created, true);
    });

    const upvoteOwnerId = await createUserWithDevice("notification-concurrency-upvote-owner");
    const voterId = await createUser("notification-concurrency-voter");
    const upvoteCandidate = await createCandidate(upvoteOwnerId, "upvote");
    await runServiceDeletionRace("gallery upvote", upvoteOwnerId, async () => {
      assert.deepEqual(
        await setGalleryVote({
          publicId: upvoteCandidate.publicId,
          sessionId: `notification-concurrency-${suffix}`,
          userId: voterId,
          upvoted: true,
        }),
        { upvoted: true, count: 1 },
      );
    });

    console.log("notification concurrency PostgreSQL checks passed");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
