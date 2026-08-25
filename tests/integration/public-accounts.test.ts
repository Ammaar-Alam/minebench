import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import { getPersonalRanking } from "../../lib/account/personalRanking";
import { claimAnonymousPublicVotes, syncAuthUser } from "../../lib/auth/account";

const db = new PrismaClient();

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("public account PostgreSQL checks require pnpm test:integration");
    return;
  }

  const suffix = randomUUID().replaceAll("-", "");
  const sessionId = `public-account-${suffix}`;
  const userId = randomUUID();
  const matchupIds: string[] = [];
  const buildIds: string[] = [];
  const modelIds: string[] = [];
  let organizationId: string | null = null;
  let promptId: string | null = null;

  try {
    const user = await db.user.create({
      data: {
        id: userId,
        email: `account-${suffix}@example.test`,
        isMineBenchAdmin: true,
      },
    });
    const authUser: SupabaseAuthUser = {
      id: user.id,
      email: user.email,
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: { full_name: "Account Admin" },
      aud: "authenticated",
      created_at: new Date().toISOString(),
    };
    const syncedUser = await syncAuthUser(authUser);
    assert.equal(syncedUser?.id, user.id);
    assert.equal(syncedUser?.isMineBenchAdmin, true);
    assert.equal(syncedUser?.displayName, "Account Admin");
    const prompt = await db.prompt.create({
      data: { text: `Public account prompt ${suffix}`, active: true },
    });
    promptId = prompt.id;
    const [modelA, modelB] = await Promise.all([
      db.model.create({
        data: {
          key: `account-a-${suffix}`,
          provider: "Provider",
          modelId: `account-a-${suffix}`,
          displayName: "Account Alpha",
        },
      }),
      db.model.create({
        data: {
          key: `account-b-${suffix}`,
          provider: "Provider",
          modelId: `account-b-${suffix}`,
          displayName: "Account Beta",
        },
      }),
    ]);
    modelIds.push(modelA.id, modelB.id);
    const [buildA, buildB] = await Promise.all([
      db.build.create({
        data: {
          promptId: prompt.id,
          modelId: modelA.id,
          gridSize: 256,
          palette: "simple",
          mode: "precise",
          blockCount: 1,
          generationTimeMs: 1,
        },
      }),
      db.build.create({
        data: {
          promptId: prompt.id,
          modelId: modelB.id,
          gridSize: 256,
          palette: "simple",
          mode: "precise",
          blockCount: 1,
          generationTimeMs: 1,
        },
      }),
    ]);
    buildIds.push(buildA.id, buildB.id);

    const [anonymousMatchup, ownedMatchup] = await Promise.all([
      db.matchup.create({
        data: {
          promptId: prompt.id,
          modelAId: modelA.id,
          modelBId: modelB.id,
          buildAId: buildA.id,
          buildBId: buildB.id,
        },
      }),
      db.matchup.create({
        data: {
          promptId: prompt.id,
          modelAId: modelA.id,
          modelBId: modelB.id,
          buildAId: buildA.id,
          buildBId: buildB.id,
        },
      }),
    ]);
    matchupIds.push(anonymousMatchup.id, ownedMatchup.id);
    await db.vote.createMany({
      data: [
        { matchupId: anonymousMatchup.id, sessionId, choice: "B" },
        { matchupId: ownedMatchup.id, sessionId: `${sessionId}-owned`, choice: "B", userId: user.id },
      ],
    });

    const organization = await db.organization.create({
      data: { slug: `account-${suffix}`, name: "Account test" },
    });
    organizationId = organization.id;
    const experiment = await db.stealthExperiment.create({
      data: {
        organizationId: organization.id,
        slug: `account-${suffix}`,
        name: "Account private boundary",
        status: "ACTIVE",
        startsAt: new Date(),
        checkpointSetFrozenAt: new Date(),
      },
    });
    const privateModel = await db.model.create({
      data: {
        key: `account-private-${suffix}`,
        provider: "Stealth",
        modelId: `account-private-${suffix}`,
        displayName: "Private model",
      },
    });
    modelIds.push(privateModel.id);
    const variant = await db.stealthVariant.create({
      data: {
        experimentId: experiment.id,
        codename: "Private model",
        status: "ACTIVE",
        modelId: privateModel.id,
      },
    });
    const privateBuild = await db.build.create({
      data: {
        promptId: prompt.id,
        modelId: privateModel.id,
        gridSize: 256,
        palette: "simple",
        mode: "precise",
        blockCount: 1,
        generationTimeMs: 1,
      },
    });
    buildIds.push(privateBuild.id);
    const privateMatchup = await db.matchup.create({
      data: {
        promptId: prompt.id,
        modelAId: modelA.id,
        modelBId: privateModel.id,
        buildAId: buildA.id,
        buildBId: privateBuild.id,
        stealthVariantId: variant.id,
      },
    });
    matchupIds.push(privateMatchup.id);
    const privateVote = await db.vote.create({
      data: { matchupId: privateMatchup.id, sessionId, choice: "A" },
    });

    assert.equal(await claimAnonymousPublicVotes(user.id, sessionId), 1);
    assert.equal((await db.vote.findUniqueOrThrow({ where: { id: privateVote.id } })).userId, null);

    const ranking = await getPersonalRanking(user.id);
    assert.equal(ranking.totalVotes, 2);
    assert.equal(ranking.ratedVotes, 2);
    assert.equal(ranking.modelsCompared, 2);
    assert.equal(ranking.models[0]?.key, modelB.key);

    await db.user.delete({ where: { id: user.id } });
    const retainedVotes = await db.vote.findMany({
      where: { matchupId: { in: [anonymousMatchup.id, ownedMatchup.id] } },
      select: { userId: true },
    });
    assert.deepEqual(retainedVotes.map((vote) => vote.userId), [null, null]);

    console.log("public account database checks passed");
  } finally {
    await db.vote.deleteMany({ where: { sessionId: { startsWith: sessionId } } });
    if (matchupIds.length) await db.matchup.deleteMany({ where: { id: { in: matchupIds } } });
    if (organizationId) await db.organization.deleteMany({ where: { id: organizationId } });
    if (buildIds.length) await db.build.deleteMany({ where: { id: { in: buildIds } } });
    if (modelIds.length) await db.model.deleteMany({ where: { id: { in: modelIds } } });
    if (promptId) await db.prompt.deleteMany({ where: { id: promptId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
