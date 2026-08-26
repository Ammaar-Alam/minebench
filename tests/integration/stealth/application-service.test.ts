import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../../lib/prisma";

async function waitFor<T>(load: () => Promise<T | null>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await load();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function installBuildInsertBarrier(params: {
  name: string;
  lockKey: number;
  modelId?: string;
}) {
  const functionName = `block_${params.name}`;
  const triggerName = `block_${params.name}_build`;
  const lockStatement = `PERFORM pg_advisory_xact_lock(${params.lockKey});`;
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      ${params.modelId ? `IF NEW."modelId" = '${params.modelId}' THEN ${lockStatement} END IF;` : lockStatement}
      RETURN NEW;
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}"
    BEFORE INSERT ON "Build"
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `);
  let release!: () => void;
  let ready!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${params.lockKey})`);
      ready();
      await released;
    },
    { timeout: 30_000 },
  );
  await acquired;
  return {
    release: async () => {
      release();
      await holder;
    },
    uninstall: async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "Build"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    },
  };
}

async function installBuildInsertFailure(params: {
  name: string;
  modelId: string;
  promptId?: string;
  message: string;
}) {
  const functionName = `reject_${params.name}`;
  const triggerName = `reject_${params.name}_build`;
  const promptCondition = params.promptId ? ` AND NEW."promptId" = '${params.promptId}'` : "";
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."modelId" = '${params.modelId}'${promptCondition} THEN
        RAISE EXCEPTION '${params.message}';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}"
    BEFORE INSERT ON "Build"
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `);
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "Build"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
  };
}

async function installGenerationResultUpdateFailure(params: {
  name: string;
  runId: string;
}) {
  const functionName = `reject_${params.name}`;
  const triggerName = `reject_${params.name}_result`;
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD."runId" = '${params.runId}' THEN
        RAISE EXCEPTION 'forced generation terminalization failure';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}"
    BEFORE UPDATE ON "StealthGenerationResult"
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `);
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "StealthGenerationResult"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
  };
}

async function installOneShotReadyFinalizationFailure(params: {
  name: string;
  codename: string;
}) {
  const sequenceName = `once_${params.name}_sequence`;
  const functionName = `reject_${params.name}`;
  const triggerName = `reject_${params.name}_variant`;
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${sequenceName}"`);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.codename = '${params.codename}' AND NEW.status = 'READY'
        AND nextval('"${sequenceName}"') = 1 THEN
        RAISE EXCEPTION 'forced upload finalization failure';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}"
    BEFORE UPDATE ON "StealthVariant"
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `);
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "StealthVariant"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    await prisma.$executeRawUnsafe(`DROP SEQUENCE "${sequenceName}"`);
  };
}

async function installDeferredArtifactOwnershipFailure(name: string) {
  const functionName = `reject_${name}`;
  const triggerName = `reject_${name}_artifact`;
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced artifact ownership commit failure';
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER "${triggerName}"
    AFTER INSERT ON "ArenaBuildArtifact"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `);
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "ArenaBuildArtifact"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
  };
}

async function installBuildDeleteBarrier(params: {
  name: string;
  lockKey: number;
  buildId: string;
}) {
  const functionName = `block_${params.name}`;
  const triggerName = `block_${params.name}_build`;
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.id = '${params.buildId}' THEN
        PERFORM pg_advisory_xact_lock(${params.lockKey});
      END IF;
      RETURN OLD;
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}"
    BEFORE DELETE ON "Build"
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `);
  let release!: () => void;
  let ready!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${params.lockKey})`);
      ready();
      await released;
    },
    { timeout: 30_000 },
  );
  await acquired;
  return {
    waitUntilBlocked: () =>
      waitFor(async () => {
        const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted = false
          ) AS blocked
        `;
        return row?.blocked ? true : null;
      }, "unaccepted build cleanup"),
    release: async () => {
      release();
      await holder;
    },
    uninstall: async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "Build"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    },
  };
}

async function main() {
  const schema = process.env.MINEBENCH_TEST_SCHEMA;
  if (!schema) {
    console.log("private evaluation application service checks require pnpm test:integration");
    return;
  }
  assert.match(schema, /^minebench_test_[a-z0-9_]+$/);
  process.env.STEALTH_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  const {
    acceptExactEmailInvitations,
    activateStealthEvaluation,
    closeStealthEvaluation,
    completeUploadedStealthCohort,
    completeUploadedStealthCohortFromStorage,
    configureStealthEndpoint,
    createStealthCohortUploadTarget,
    createStealthEvaluation,
    deleteUnusedDraftEvaluation,
    disableStealthEndpoint,
    getStealthEvaluationWorkspace,
    inviteOrganizationMember,
    listStealthEvaluationWorkspaces,
    reconcileStealthGoalPause,
    purgeDueStealthEvaluations,
    purgeStealthEvaluationIfDue,
    removeOrganizationMember,
    resumeStealthEvaluation,
    syncExperimentReadiness,
    updateOrganizationMember,
    updateStealthEvaluation,
  } = await import("../../../lib/stealth/service");
  const { prepareStealthCohortPrompts } = await import("../../../lib/stealth/cohort");
  const { deleteUnacceptedStealthBuild, persistStealthBuild } = await import(
    "../../../lib/stealth/generation"
  );
  const { getStealthExperimentReport } = await import("../../../lib/stealth/report");
  const {
    failStealthGenerationRun,
    finishStealthGenerationRun,
    generateStealthPromptForRun,
    getStealthGenerationPlan,
    startStealthGeneration,
  } = await import("../../../lib/stealth/generationRun");

  const suffix = randomUUID().slice(0, 8);
  const [admin, member, outsider, invitee] = await Promise.all(
    ["admin", "member", "outsider", "invitee"].map((name) =>
      prisma.user.create({
        data: {
          id: randomUUID(),
          email: `${name}-${suffix}@example.test`,
        },
      }),
    ),
  );
  const [organization, otherOrganization] = await Promise.all([
    prisma.organization.create({
      data: {
        name: `Service ${suffix}`,
        slug: `service-${suffix}`,
        memberships: {
          create: [
            { userId: admin.id, role: "ADMIN" },
            { userId: member.id, role: "MEMBER" },
          ],
        },
      },
    }),
    prisma.organization.create({
      data: {
        name: `Other ${suffix}`,
        slug: `other-${suffix}`,
        memberships: { create: { userId: outsider.id, role: "MEMBER" } },
      },
    }),
  ]);
  const adminActor = { organizationUser: { userId: admin.id } } as const;
  const memberActor = { organizationUser: { userId: member.id } } as const;
  const outsiderActor = { organizationUser: { userId: outsider.id } } as const;
  const minebenchAdmin = { minebenchAdmin: true } as const;
  const cohortPrompts = await prepareStealthCohortPrompts();
  const disabledPrompt = cohortPrompts[0];
  assert.ok(disabledPrompt);
  await prisma.prompt.update({ where: { id: disabledPrompt.prompt.id }, data: { active: false } });
  await prepareStealthCohortPrompts();
  assert.equal(
    (await prisma.prompt.findUniqueOrThrow({ where: { id: disabledPrompt.prompt.id } })).active,
    false,
    "private cohort preparation must preserve public prompt eligibility",
  );

  await assert.rejects(
    inviteOrganizationMember(memberActor, organization.id, {
      email: invitee.email,
      role: "MEMBER",
    }),
    /Admin access is required/,
  );
  await inviteOrganizationMember(adminActor, organization.id, {
    email: invitee.email,
    role: "MEMBER",
  });
  assert.equal(
    await prisma.organizationMembership.count({
      where: { organizationId: organization.id, userId: invitee.id },
    }),
    0,
    "an invitation must not grant membership before acceptance",
  );
  await updateOrganizationMember(adminActor, organization.id, {
    email: invitee.email,
    role: "ADMIN",
  });
  await acceptExactEmailInvitations({ id: invitee.id, email: invitee.email });
  assert.equal(
    (
      await prisma.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: { organizationId: organization.id, userId: invitee.id },
        },
      })
    ).role,
    "ADMIN",
  );
  await updateOrganizationMember(adminActor, organization.id, {
    email: invitee.email,
    role: "MEMBER",
  });
  await assert.rejects(
    inviteOrganizationMember(adminActor, organization.id, {
      email: invitee.email,
      role: "ADMIN",
    }),
    /already a member/,
  );
  assert.equal(
    (
      await prisma.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: { organizationId: organization.id, userId: invitee.id },
        },
      })
    ).role,
    "MEMBER",
  );

  await prisma.organizationInvitation.create({
    data: {
      organizationId: organization.id,
      email: admin.email,
      role: "MEMBER",
      authUserId: admin.id,
    },
  });
  await acceptExactEmailInvitations({ id: admin.id, email: admin.email });
  assert.equal(
    (
      await prisma.organizationMembership.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: organization.id, userId: admin.id } },
      })
    ).role,
    "ADMIN",
    "a stale invitation cannot change an existing member role",
  );
  assert.ok(
    (
      await prisma.organizationInvitation.findUniqueOrThrow({
        where: { organizationId_email: { organizationId: organization.id, email: admin.email } },
      })
    ).revokedAt,
  );

  const revokedInvitee = await prisma.user.create({
    data: { id: randomUUID(), email: `revoked-${suffix}@example.test` },
  });
  await prisma.organizationInvitation.create({
    data: {
      organizationId: organization.id,
      email: revokedInvitee.email,
      role: "MEMBER",
      authUserId: revokedInvitee.id,
      revokedAt: new Date(),
    },
  });
  await acceptExactEmailInvitations({ id: revokedInvitee.id, email: revokedInvitee.email });
  assert.equal(
    await prisma.organizationMembership.count({
      where: { organizationId: organization.id, userId: revokedInvitee.id },
    }),
    0,
  );

  const evaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Checkpoint service ${suffix}`,
  });
  await assert.rejects(
    createStealthEvaluation(outsiderActor, organization.id, { name: "Cross organization" }),
    /Organization access is required/,
  );
  await assert.rejects(
    createStealthEvaluation(memberActor, organization.id, {
      name: "Contract override",
      retentionDays: 7,
    }),
    /MineBench admin access is required/,
  );

  await updateStealthEvaluation(memberActor, organization.id, evaluation.id, {
    targetDecisiveVotes: 250,
    pauseAtGoal: false,
  });
  await assert.rejects(
    updateOrganizationMember(adminActor, organization.id, {
      email: admin.email,
      role: "MEMBER",
    }),
    /at least one Admin/,
  );
  await assert.rejects(
    removeOrganizationMember(adminActor, organization.id, { email: admin.email }),
    /at least one Admin/,
  );

  const [adminA, adminB] = await Promise.all(
    ["a", "b"].map((name) =>
      prisma.user.create({
        data: { id: randomUUID(), email: `concurrent-admin-${name}-${suffix}@example.test` },
      }),
    ),
  );
  const concurrentOrganization = await prisma.organization.create({
    data: {
      name: `Concurrent ${suffix}`,
      slug: `concurrent-${suffix}`,
      memberships: {
        create: [
          { userId: adminA.id, role: "ADMIN" },
          { userId: adminB.id, role: "ADMIN" },
        ],
      },
    },
  });
  const concurrentChanges = await Promise.allSettled([
    updateOrganizationMember(
      { organizationUser: { userId: adminA.id } },
      concurrentOrganization.id,
      { email: adminB.email, role: "MEMBER" },
    ),
    updateOrganizationMember(
      { organizationUser: { userId: adminB.id } },
      concurrentOrganization.id,
      { email: adminA.email, role: "MEMBER" },
    ),
  ]);
  assert.equal(concurrentChanges.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    await prisma.organizationMembership.count({
      where: { organizationId: concurrentOrganization.id, role: "ADMIN" },
    }),
    1,
    "concurrent membership changes must preserve an Admin",
  );

  const checkpoint = await configureStealthEndpoint(
    memberActor,
    organization.id,
    evaluation.id,
    {
      codename: "Checkpoint One",
      config: {
        protocol: "openai-compatible",
        endpointUrl: "https://checkpoint.example.test/v1",
        apiKey: "test-secret-key",
        modelId: "checkpoint-1",
        requireStructuredOutput: true,
        enableTools: true,
      },
    },
  );
  const workspace = await getStealthEvaluationWorkspace(
    memberActor,
    organization.id,
    evaluation.id,
  );
  assert.equal(workspace?.targetDecisiveVotes, 250);
  assert.equal(workspace?.pauseAtGoal, false);
  assert.equal(workspace?.checkpoints[0]?.credentialConfigured, true);
  assert.doesNotMatch(JSON.stringify(workspace), /test-secret-key|encryptedConfig|voxelStoragePath/);
  await assert.rejects(
    activateStealthEvaluation(memberActor, organization.id, evaluation.id),
    /not ready/,
  );

  const staleEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Stale generation ${suffix}`,
  });
  const staleCheckpoint = await configureStealthEndpoint(
    memberActor,
    organization.id,
    staleEvaluation.id,
    {
      codename: "Stale generation",
      config: {
        protocol: "openrouter",
        endpointUrl: "",
        apiKey: "stale-generation-secret-key",
        modelId: `stale-generation-${suffix}`,
        requireStructuredOutput: true,
        enableTools: false,
      },
    },
  );
  const [stalePrompt] = await prepareStealthCohortPrompts();
  assert.ok(stalePrompt);
  const staleReadAt = new Date(Date.now() - 16 * 60_000);
  const staleRun = await prisma.stealthGenerationRun.create({
    data: {
      variantId: staleCheckpoint.variantId,
      status: "RUNNING",
      promptCohortId: "stale-read-recovery",
      configuration: {},
      expectedBuildCount: 1,
      startedAt: staleReadAt,
      results: {
        create: { promptId: stalePrompt.prompt.id, status: "QUEUED", updatedAt: staleReadAt },
      },
    },
  });
  await prisma.stealthVariant.update({
    where: { id: staleCheckpoint.variantId },
    data: { status: "GENERATING" },
  });
  await prisma.stealthExperiment.update({
    where: { id: staleEvaluation.id },
    data: { status: "GENERATING" },
  });
  const recoveredWorkspace = await getStealthEvaluationWorkspace(
    memberActor,
    organization.id,
    staleEvaluation.id,
  );
  assert.equal(recoveredWorkspace?.checkpoints[0]?.latestGenerationRun?.status, "FAILED");
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: staleRun.id } })).status,
    "FAILED",
    "workspace status reads must reclaim expired generation reservations",
  );
  const staleVariant = await prisma.stealthVariant.findUniqueOrThrow({
    where: { id: staleCheckpoint.variantId },
  });
  const staleBuild = await prisma.build.create({
    data: {
      promptId: stalePrompt.prompt.id,
      modelId: staleVariant.modelId,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      voxelData: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
      voxelSha256: `stale-complete-${suffix}`,
      blockCount: 1,
      generationTimeMs: 0,
    },
  });
  const completeStaleRun = await prisma.stealthGenerationRun.create({
    data: {
      variantId: staleCheckpoint.variantId,
      status: "RUNNING",
      promptCohortId: "stale-complete-recovery",
      configuration: {},
      expectedBuildCount: 1,
      completedBuildCount: 1,
      startedAt: staleReadAt,
      results: {
        create: {
          promptId: stalePrompt.prompt.id,
          buildId: staleBuild.id,
          status: "READY",
          updatedAt: staleReadAt,
        },
      },
    },
  });
  await prisma.stealthVariant.update({
    where: { id: staleCheckpoint.variantId },
    data: { status: "GENERATING", generatedBuildCount: 1, expectedBuildCount: 1 },
  });
  await prisma.stealthExperiment.update({
    where: { id: staleEvaluation.id },
    data: { status: "GENERATING" },
  });
  await getStealthEvaluationWorkspace(memberActor, organization.id, staleEvaluation.id);
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: completeStaleRun.id } }))
      .status,
    "SUCCEEDED",
  );
  const recoveredVariant = await prisma.stealthVariant.findUniqueOrThrow({
    where: { id: staleCheckpoint.variantId },
  });
  assert.equal(recoveredVariant.status, "READY");
  assert.equal(recoveredVariant.endpointEnabled, false);
  assert.equal(
    await prisma.stealthEndpointCredential.count({ where: { variantId: staleCheckpoint.variantId } }),
    0,
  );
  assert.equal(
    (await prisma.stealthExperiment.findUniqueOrThrow({ where: { id: staleEvaluation.id } })).status,
    "READY",
  );
  await configureStealthEndpoint(memberActor, organization.id, staleEvaluation.id, {
    variantId: staleCheckpoint.variantId,
    codename: "Stale generation",
    config: {
      protocol: "openrouter",
      endpointUrl: "",
      apiKey: "refreshed-stale-generation-secret-key",
      modelId: `stale-generation-${suffix}`,
      requireStructuredOutput: true,
      enableTools: false,
    },
  });
  assert.equal(
    (await prisma.stealthVariant.findUniqueOrThrow({ where: { id: staleCheckpoint.variantId } }))
      .status,
    "DRAFT",
    "an outdated complete endpoint checkpoint must accept a narrow cohort refresh",
  );

  const privateCacheVariant = await prisma.stealthVariant.findUniqueOrThrow({
    where: { id: checkpoint.variantId },
    select: { modelId: true },
  });
  const privateCachePrompt = await prisma.prompt.create({
    data: { text: `Private cache ${suffix}` },
  });
  const privateCacheBuild = await prisma.build.create({
    data: {
      promptId: privateCachePrompt.id,
      modelId: privateCacheVariant.modelId,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      voxelData: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
      voxelSha256: "private-cache-checksum",
      blockCount: 1,
      generationTimeMs: 0,
    },
  });
  const { getArenaBuildMeta } = await import("../../../lib/arena/buildMetaCache");
  assert.ok(await getArenaBuildMeta(privateCacheBuild.id, privateCacheBuild.voxelSha256));
  await prisma.build.delete({ where: { id: privateCacheBuild.id } });
  assert.equal(
    await getArenaBuildMeta(privateCacheBuild.id, privateCacheBuild.voxelSha256),
    null,
    "retained private metadata must not survive database deletion",
  );
  await prisma.prompt.delete({ where: { id: privateCachePrompt.id } });

  await disableStealthEndpoint(memberActor, organization.id, checkpoint.variantId);
  assert.equal(
    await prisma.stealthEndpointCredential.count({ where: { variantId: checkpoint.variantId } }),
    0,
  );
  const pendingUploadPath = `stealth-cohort-uploads/v1/${organization.id}/${evaluation.id}/${randomUUID()}.json`;
  const pendingUpload = await prisma.stealthCohortUpload.create({
    data: {
      id: randomUUID(),
      experimentId: evaluation.id,
      bucket: "builds",
      path: pendingUploadPath,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await assert.rejects(
    deleteUnusedDraftEvaluation(memberActor, organization.id, evaluation.id),
    /pending cohort upload/i,
  );
  await prisma.stealthCohortUpload.update({
    where: { id: pendingUpload.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expiredUploadFetch = global.fetch;
  let expiredUploadRead = false;
  global.fetch = (async () => {
    expiredUploadRead = true;
    throw new Error("Expired uploads must not be read");
  }) as typeof fetch;
  try {
    await assert.rejects(
      completeUploadedStealthCohortFromStorage(
        memberActor,
        organization.id,
        evaluation.id,
        {
          codename: "Expired upload",
          bucket: pendingUpload.bucket,
          path: pendingUpload.path,
        },
      ),
      /reference is invalid/i,
    );
  } finally {
    global.fetch = expiredUploadFetch;
  }
  assert.equal(expiredUploadRead, false);
  const draftStorageUrl = process.env.SUPABASE_URL;
  const draftStorageKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const draftFetch = global.fetch;
  const deletedDraftUploads: string[] = [];
  process.env.SUPABASE_URL = "https://storage.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "storage-test-key";
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).includes("/storage/v1/object/list/")) {
      assert.equal(
        (await prisma.stealthExperiment.findUniqueOrThrow({ where: { id: evaluation.id } })).status,
        "CLOSED",
        "draft deletion must reserve the evaluation before sweeping storage",
      );
      return Response.json([{ id: "orphan", name: "orphan.json.gz" }]);
    }
    const body = JSON.parse(String(init?.body)) as { prefixes: string[] };
    deletedDraftUploads.push(...body.prefixes);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await deleteUnusedDraftEvaluation(memberActor, organization.id, evaluation.id);
  } finally {
    global.fetch = draftFetch;
    if (draftStorageUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = draftStorageUrl;
    if (draftStorageKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = draftStorageKey;
  }
  assert.deepEqual(deletedDraftUploads, [
    pendingUploadPath,
    `stealth-builds/v1/${checkpoint.variantId}/orphan.json.gz`,
  ]);
  assert.equal(await prisma.stealthExperiment.count({ where: { id: evaluation.id } }), 0);

  const generationEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Generation ${suffix}`,
  });
  const generationCheckpoint = await configureStealthEndpoint(
    memberActor,
    organization.id,
    generationEvaluation.id,
    {
      codename: "Generation One",
      config: {
        protocol: "openrouter",
        endpointUrl: "",
        apiKey: "generation-secret-key",
        modelId: `generation-${suffix}`,
        requireStructuredOutput: true,
        enableTools: false,
      },
    },
  );
  await assert.rejects(
    startStealthGeneration(
      memberActor,
      organization.id,
      generationCheckpoint.variantId,
      { maxAttempts: 0, concurrency: 1 },
      async () => "invalid-attempt-workflow",
    ),
    /Attempts must be from 1 to 10/,
  );
  await assert.rejects(
    startStealthGeneration(
      memberActor,
      organization.id,
      generationCheckpoint.variantId,
      { maxAttempts: 3, concurrency: 16 },
      async () => "invalid-concurrency-workflow",
    ),
    /Concurrency must be from 1 to 15/,
  );
  let launchCount = 0;
  const concurrentStarts = await Promise.allSettled([
    startStealthGeneration(
      memberActor,
      organization.id,
      generationCheckpoint.variantId,
      { maxAttempts: 3, concurrency: 3 },
      async (runId) => {
        launchCount += 1;
        return `workflow-${runId}`;
      },
    ),
    startStealthGeneration(
      memberActor,
      organization.id,
      generationCheckpoint.variantId,
      { maxAttempts: 3, concurrency: 3 },
      async (runId) => {
        launchCount += 1;
        return `workflow-${runId}`;
      },
    ),
  ]);
  assert.equal(concurrentStarts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrentStarts.filter((result) => result.status === "rejected").length, 1);
  assert.match(
    String(concurrentStarts.find((result) => result.status === "rejected")?.reason),
    /already running/,
  );
  assert.equal(launchCount, 1);
  const generationRun = concurrentStarts.find(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startStealthGeneration>>> =>
      result.status === "fulfilled",
  )!.value;
  assert.equal(
    (
      await prisma.stealthGenerationRun.findUniqueOrThrow({
        where: { id: generationRun.runId },
      })
    ).workflowRunId,
    `workflow-${generationRun.runId}`,
  );
  assert.equal((await getStealthGenerationPlan(generationRun.runId))?.promptBatches[0]?.length, 3);
  await failStealthGenerationRun(generationRun.runId, "Workflow startup failed");
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: generationRun.runId } }))
      .status,
    "FAILED",
  );
  let attachmentFailureRunId = "";
  await assert.rejects(
    startStealthGeneration(
      memberActor,
      organization.id,
      generationCheckpoint.variantId,
      { maxAttempts: 3, concurrency: 2 },
      async (runId) => {
        attachmentFailureRunId = runId;
        return generationRun.workflowRunId;
      },
    ),
  );
  assert.ok(attachmentFailureRunId);
  const attachmentFailure = await prisma.stealthGenerationRun.findUniqueOrThrow({
    where: { id: attachmentFailureRunId },
  });
  assert.equal(attachmentFailure.status, "FAILED");
  assert.equal(attachmentFailure.workflowRunId, null);
  await assert.rejects(
    startStealthGeneration(
      memberActor,
      organization.id,
      generationCheckpoint.variantId,
      { maxAttempts: 3, concurrency: 2 },
      async () => {
        throw new Error("Startup failed at https://private.example.test api_key=secret-value");
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[endpoint]") &&
      !error.message.includes("secret-value"),
  );
  const launchFailure = await prisma.stealthGenerationRun.findFirstOrThrow({
    where: { variantId: generationCheckpoint.variantId },
    orderBy: { startedAt: "desc" },
  });
  assert.equal(launchFailure.status, "FAILED");
  assert.equal(launchFailure.workflowRunId, null);
  assert.equal(
    (await prisma.stealthVariant.findUniqueOrThrow({ where: { id: generationCheckpoint.variantId } }))
      .status,
    "DRAFT",
  );
  const interruptedRun = await startStealthGeneration(
    memberActor,
    organization.id,
    generationCheckpoint.variantId,
    { maxAttempts: 3, concurrency: 1 },
    async (runId) => `interrupted-${runId}`,
  );
  const staleAt = new Date(Date.now() - 20 * 60_000);
  await prisma.stealthGenerationResult.updateMany({
    where: { runId: interruptedRun.runId },
    data: { updatedAt: staleAt },
  });
  await prisma.stealthGenerationRun.update({
    where: { id: interruptedRun.runId },
    data: { startedAt: staleAt },
  });
  const reclaimedRun = await startStealthGeneration(
    memberActor,
    organization.id,
    generationCheckpoint.variantId,
    { maxAttempts: 3, concurrency: 1 },
    async (runId) => `reclaimed-${runId}`,
  );
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: interruptedRun.runId } }))
      .status,
    "FAILED",
  );
  await failStealthGenerationRun(reclaimedRun.runId, "Reclaimed reservation test complete");
  const retryRun = await startStealthGeneration(
    memberActor,
    organization.id,
    generationCheckpoint.variantId,
    { maxAttempts: 3, concurrency: 1 },
    async (runId) => `workflow-${runId}`,
  );
  const generatedBlocks = Array.from({ length: 500 }, (_, index) => ({
    x: index % 40,
    y: index % 25,
    z: Math.floor(index / 200),
    type: "stone",
  }));
  const originalGenerationFetch = global.fetch;
  let generationRequestCount = 0;
  let markFirstRequestStarted!: () => void;
  let releaseFirstRequest!: () => void;
  const firstRequestStarted = new Promise<void>((resolve) => {
    markFirstRequestStarted = resolve;
  });
  const firstRequestRelease = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  global.fetch = (async () => {
    generationRequestCount += 1;
    if (generationRequestCount === 1) {
      markFirstRequestStarted();
      await firstRequestRelease;
    }
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ version: "1.0", blocks: generatedBlocks }),
          },
        },
      ],
    });
  }) as typeof fetch;
  let firstGeneration: Promise<void> | null = null;
  try {
    const originalCohortId = (
      await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: retryRun.runId } })
    ).promptCohortId;
    await prisma.stealthGenerationRun.update({
      where: { id: retryRun.runId },
      data: { promptCohortId: "prompts-v1:stale" },
    });
    await assert.rejects(getStealthGenerationPlan(retryRun.runId), /cohort has changed/);
    await prisma.stealthGenerationRun.update({
      where: { id: retryRun.runId },
      data: { promptCohortId: originalCohortId },
    });
    const plan = await getStealthGenerationPlan(retryRun.runId);
    assert.ok(plan);
    const promptSlugs = plan.promptBatches.flat();
    const firstPrompt = promptSlugs[0];
    assert.ok(firstPrompt);
    firstGeneration = generateStealthPromptForRun({
      runId: retryRun.runId,
      promptSlug: firstPrompt,
    });
    await firstRequestStarted;
    await assert.rejects(
      configureStealthEndpoint(memberActor, organization.id, generationEvaluation.id, {
        variantId: generationCheckpoint.variantId,
        codename: "Generation One",
        config: {
          protocol: "openrouter",
          endpointUrl: "",
          apiKey: "replacement-secret-key",
          modelId: `replacement-${suffix}`,
          requireStructuredOutput: true,
          enableTools: false,
        },
      }),
      /still running/,
    );
    await assert.rejects(
      completeUploadedStealthCohort(memberActor, organization.id, generationEvaluation.id, {
        variantId: generationCheckpoint.variantId,
        codename: "Generation One",
        builds: cohortPrompts.map((prompt) => ({
          promptSlug: prompt.slug,
          build: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
        })),
      }),
      /still running/,
    );
    const secondPrompt = promptSlugs[1];
    assert.ok(secondPrompt);
    await generateStealthPromptForRun({ runId: retryRun.runId, promptSlug: secondPrompt });
    assert.equal(
      generationRequestCount,
      1,
      "duplicate workflow delivery must honor the persisted concurrency limit",
    );
    await generateStealthPromptForRun({ runId: retryRun.runId, promptSlug: firstPrompt });
    assert.equal(generationRequestCount, 1, "an in-flight prompt must not call the provider twice");
    await finishStealthGenerationRun(retryRun.runId);
    assert.equal(
      (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: retryRun.runId } }))
        .status,
      "RUNNING",
      "duplicate finalization must not terminate active prompt work",
    );
    releaseFirstRequest();
    await firstGeneration;
    await generateStealthPromptForRun({ runId: retryRun.runId, promptSlug: firstPrompt });
    assert.equal(generationRequestCount, 1, "a persisted prompt build must be reused");
    for (const promptSlug of promptSlugs.slice(1)) {
      await generateStealthPromptForRun({ runId: retryRun.runId, promptSlug });
    }
    await failStealthGenerationRun(retryRun.runId, "Final workflow step failed");
    await finishStealthGenerationRun(retryRun.runId);
  } finally {
    releaseFirstRequest();
    await firstGeneration?.catch(() => undefined);
    global.fetch = originalGenerationFetch;
  }
  const completedRun = await prisma.stealthGenerationRun.findUniqueOrThrow({
    where: { id: retryRun.runId },
  });
  assert.equal(completedRun.status, "SUCCEEDED");
  assert.equal(completedRun.completedBuildCount, 15);
  assert.equal(completedRun.failedBuildCount, 0);
  assert.equal(completedRun.providerCallCount, 15);
  assert.equal(completedRun.retryCount, 0);
  assert.equal(
    (await prisma.stealthVariant.findUniqueOrThrow({ where: { id: generationCheckpoint.variantId } }))
      .status,
    "READY",
  );
  assert.equal(
    await prisma.stealthEndpointCredential.count({
      where: { variantId: generationCheckpoint.variantId },
    }),
    0,
  );
  assert.equal(
    (await prisma.prompt.findUniqueOrThrow({ where: { id: disabledPrompt.prompt.id } })).active,
    false,
    "private build persistence must preserve public prompt eligibility",
  );
  await prisma.prompt.update({ where: { id: disabledPrompt.prompt.id }, data: { active: true } });

  const closingEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Closing generation ${suffix}`,
  });
  const closingCheckpoint = await configureStealthEndpoint(
    memberActor,
    organization.id,
    closingEvaluation.id,
    {
      codename: "Closing generation",
      config: {
        protocol: "openrouter",
        endpointUrl: "",
        apiKey: "closing-generation-secret-key",
        modelId: `closing-generation-${suffix}`,
        requireStructuredOutput: true,
        enableTools: false,
      },
    },
  );
  const closingRun = await startStealthGeneration(
    memberActor,
    organization.id,
    closingCheckpoint.variantId,
    { maxAttempts: 1, concurrency: 1 },
    async (runId) => `workflow-${runId}`,
  );
  const closingPrompt = (await getStealthGenerationPlan(closingRun.runId))?.promptBatches[0]?.[0];
  assert.ok(closingPrompt);
  let markClosingRequestStarted!: () => void;
  let releaseClosingRequest!: () => void;
  const closingRequestStarted = new Promise<void>((resolve) => {
    markClosingRequestStarted = resolve;
  });
  const closingRequestRelease = new Promise<void>((resolve) => {
    releaseClosingRequest = resolve;
  });
  global.fetch = (async () => {
    markClosingRequestStarted();
    await closingRequestRelease;
    return Response.json({
      choices: [
        { message: { content: JSON.stringify({ version: "1.0", blocks: generatedBlocks }) } },
      ],
    });
  }) as typeof fetch;
  const closingGeneration = generateStealthPromptForRun({
    runId: closingRun.runId,
    promptSlug: closingPrompt,
  });
  try {
    await closingRequestStarted;
    await disableStealthEndpoint(memberActor, organization.id, closingCheckpoint.variantId);
    releaseClosingRequest();
    await closingGeneration;
  } finally {
    releaseClosingRequest();
    await closingGeneration.catch(() => undefined);
    global.fetch = originalGenerationFetch;
  }
  const revokedGenerationVariant = await prisma.stealthVariant.findUniqueOrThrow({
    where: { id: closingCheckpoint.variantId },
  });
  assert.equal(revokedGenerationVariant.status, "DRAFT");
  assert.equal(revokedGenerationVariant.endpointEnabled, false);
  assert.equal(
    await prisma.build.count({ where: { modelId: revokedGenerationVariant.modelId } }),
    0,
    "revocation during provider work must fence build persistence",
  );
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: closingRun.runId } }))
      .status,
    "FAILED",
  );
  assert.equal(
    await prisma.stealthEndpointCredential.count({ where: { variantId: closingCheckpoint.variantId } }),
    0,
  );

  const atomicCloseEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Atomic close ${suffix}`,
  });
  const atomicCloseCheckpoint = await configureStealthEndpoint(
    memberActor,
    organization.id,
    atomicCloseEvaluation.id,
    {
      codename: "Atomic close",
      config: {
        protocol: "openrouter",
        endpointUrl: "",
        apiKey: "atomic-close-secret-key",
        modelId: `atomic-close-${suffix}`,
        requireStructuredOutput: true,
        enableTools: false,
      },
    },
  );
  const atomicCloseRun = await startStealthGeneration(
    memberActor,
    organization.id,
    atomicCloseCheckpoint.variantId,
    { maxAttempts: 1, concurrency: 1 },
    async (runId) => `workflow-${runId}`,
  );
  const removeTerminalizationFailure = await installGenerationResultUpdateFailure({
    name: `close_${suffix}`,
    runId: atomicCloseRun.runId,
  });
  try {
    await assert.rejects(
      closeStealthEvaluation(memberActor, organization.id, atomicCloseEvaluation.id, {
        retentionDays: 91,
      }),
      /forced generation terminalization failure/,
    );
  } finally {
    await removeTerminalizationFailure();
  }
  assert.notEqual(
    (await prisma.stealthExperiment.findUniqueOrThrow({ where: { id: atomicCloseEvaluation.id } }))
      .status,
    "CLOSED",
    "closure must roll back if active runs cannot terminalize",
  );
  assert.ok(
    (await prisma.stealthExperiment.findUniqueOrThrow({ where: { id: atomicCloseEvaluation.id } }))
      .endedAt,
    "a close request must retain its non-votable reservation when finalization fails",
  );
  assert.equal(
    (
      await prisma.stealthExperiment.findUniqueOrThrow({
        where: { id: atomicCloseEvaluation.id },
      })
    ).retentionDays,
    91,
    "a close retry must retain the selected retention term",
  );
  assert.equal(
    (
      await prisma.stealthVariant.findUniqueOrThrow({
        where: { id: atomicCloseCheckpoint.variantId },
      })
    ).endpointEnabled,
    false,
    "the close reservation must revoke provider access before draining",
  );
  assert.equal(
    await prisma.stealthEndpointCredential.count({
      where: { variantId: atomicCloseCheckpoint.variantId },
    }),
    0,
  );
  await assert.rejects(
    resumeStealthEvaluation(memberActor, organization.id, atomicCloseEvaluation.id),
    /closing/,
  );
  await assert.rejects(
    updateStealthEvaluation(memberActor, organization.id, atomicCloseEvaluation.id, {
      targetDecisiveVotes: 500,
    }),
    /closing/,
  );
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: atomicCloseRun.runId } }))
      .status,
    "RUNNING",
  );
  await prisma.stealthGenerationResult.updateMany({
    where: { runId: atomicCloseRun.runId },
    data: { status: "READY" },
  });
  await closeStealthEvaluation(memberActor, organization.id, atomicCloseEvaluation.id);
  assert.equal(
    (
      await prisma.stealthExperiment.findUniqueOrThrow({
        where: { id: atomicCloseEvaluation.id },
      })
    ).retentionDays,
    91,
  );
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: atomicCloseRun.runId } }))
      .status,
    "SUCCEEDED",
    "a fully persisted cohort must remain successful when closure wins finalization",
  );

  const persistenceRaceEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Persistence race ${suffix}`,
  });
  const persistenceRaceCheckpoint = await configureStealthEndpoint(
    memberActor,
    organization.id,
    persistenceRaceEvaluation.id,
    {
      codename: "Persistence race",
      config: {
        protocol: "openrouter",
        endpointUrl: "",
        apiKey: "persistence-race-secret-key",
        modelId: `persistence-race-${suffix}`,
        requireStructuredOutput: true,
        enableTools: false,
      },
    },
  );
  const persistenceRaceRun = await startStealthGeneration(
    memberActor,
    organization.id,
    persistenceRaceCheckpoint.variantId,
    { maxAttempts: 1, concurrency: 1 },
    async (runId) => `workflow-${runId}`,
  );
  const persistenceRaceModelId = (
    await prisma.stealthVariant.findUniqueOrThrow({
      where: { id: persistenceRaceCheckpoint.variantId },
      select: { modelId: true },
    })
  ).modelId;
  const persistenceBarrier = await installBuildInsertBarrier({
    name: `persistence_${suffix}`,
    lockKey: Number.parseInt(suffix, 16),
    modelId: persistenceRaceModelId,
  });
  global.fetch = (async () =>
    Response.json({
      choices: [
        { message: { content: JSON.stringify({ version: "1.0", blocks: generatedBlocks }) } },
      ],
    })) as typeof fetch;
  const persistenceRaceGeneration = generateStealthPromptForRun({
    runId: persistenceRaceRun.runId,
    promptSlug: cohortPrompts[0]!.slug,
  });
  try {
    await waitFor(
      async () => {
        const result = await prisma.stealthGenerationResult.findUnique({
          where: {
            runId_promptId: {
              runId: persistenceRaceRun.runId,
              promptId: cohortPrompts[0]!.prompt.id,
            },
          },
          select: { status: true },
        });
        return result?.status === "VALIDATING" ? result : null;
      },
      "generation persistence",
    );
    await closeStealthEvaluation(memberActor, organization.id, persistenceRaceEvaluation.id);
  } finally {
    await persistenceBarrier.release();
    await persistenceRaceGeneration;
    global.fetch = originalGenerationFetch;
    await persistenceBarrier.uninstall();
  }
  const persistenceRaceVariant = await prisma.stealthVariant.findUniqueOrThrow({
    where: { id: persistenceRaceCheckpoint.variantId },
  });
  assert.equal(
    await prisma.build.count({ where: { modelId: persistenceRaceVariant.modelId } }),
    0,
    "a build that loses the close race must be removed",
  );

  const failureCheckpoint = await configureStealthEndpoint(
    memberActor,
    organization.id,
    generationEvaluation.id,
    {
      codename: "Generation Failure",
      config: {
        protocol: "openrouter",
        endpointUrl: "",
        apiKey: "generation-failure-secret-key",
        modelId: `generation-failure-${suffix}`,
        requireStructuredOutput: true,
        enableTools: false,
      },
    },
  );
  const noBuildRun = await startStealthGeneration(
    memberActor,
    organization.id,
    failureCheckpoint.variantId,
    { maxAttempts: 2, concurrency: 1 },
    async (runId) => `workflow-${runId}`,
  );
  const failurePrompts = (await getStealthGenerationPlan(noBuildRun.runId))?.promptBatches.flat();
  assert.ok(failurePrompts && failurePrompts.length >= 3);
  const [validationFailurePrompt, providerFailurePrompt, persistenceFailurePrompt] = failurePrompts;
  assert.ok(validationFailurePrompt && providerFailurePrompt && persistenceFailurePrompt);
  let failedProviderRequests = 0;
  global.fetch = (async () => {
    failedProviderRequests += 1;
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ version: "1.0", blocks: [] }) } }],
    });
  }) as typeof fetch;
  let conflictingBuildId: string | null = null;
  try {
    await generateStealthPromptForRun({
      runId: noBuildRun.runId,
      promptSlug: validationFailurePrompt,
    });
    global.fetch = (async () => {
      failedProviderRequests += 1;
      return new Response('{"error":"generation-failure-secret-key"}', { status: 401 });
    }) as typeof fetch;
    await generateStealthPromptForRun({
      runId: noBuildRun.runId,
      promptSlug: providerFailurePrompt,
    });
    const providerFailurePromptId = cohortPrompts.find(
      (prompt) => prompt.slug === providerFailurePrompt,
    )?.prompt.id;
    assert.ok(providerFailurePromptId);
    const providerFailure = await prisma.stealthGenerationResult.findUniqueOrThrow({
      where: {
        runId_promptId: { runId: noBuildRun.runId, promptId: providerFailurePromptId },
      },
    });
    assert.doesNotMatch(providerFailure.error ?? "", /generation-failure-secret-key/);
    assert.match(providerFailure.error ?? "", /\[redacted\]/);
    const failureVariant = await prisma.stealthVariant.findUniqueOrThrow({
      where: { id: failureCheckpoint.variantId },
      select: { modelId: true },
    });
    const persistencePrompt = (await prepareStealthCohortPrompts()).find(
      (prompt) => prompt.slug === persistenceFailurePrompt,
    );
    assert.ok(persistencePrompt);
    global.fetch = (async () => {
      failedProviderRequests += 1;
      const { persistStealthBuild } = await import("../../../lib/stealth/generation");
      const conflict = await persistStealthBuild({
        variantId: failureCheckpoint.variantId,
        modelId: failureVariant.modelId,
        promptSlug: persistencePrompt.slug,
        promptText: persistencePrompt.text,
        build: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
        generationTimeMs: 0,
      });
      conflictingBuildId = conflict.id;
      return Response.json({
        choices: [
          { message: { content: JSON.stringify({ version: "1.0", blocks: generatedBlocks }) } },
        ],
      });
    }) as typeof fetch;
    await generateStealthPromptForRun({
      runId: noBuildRun.runId,
      promptSlug: persistenceFailurePrompt,
    });
    await finishStealthGenerationRun(noBuildRun.runId);
  } finally {
    global.fetch = originalGenerationFetch;
  }
  const noBuildFailure = await prisma.stealthGenerationRun.findUniqueOrThrow({
    where: { id: noBuildRun.runId },
  });
  assert.equal(failedProviderRequests, 5);
  assert.equal(noBuildFailure.status, "FAILED");
  assert.equal(noBuildFailure.completedBuildCount, 0);
  assert.equal(noBuildFailure.failedBuildCount, 3);
  assert.equal(noBuildFailure.providerCallCount, 5);
  assert.equal(noBuildFailure.retryCount, 2);
  assert.equal(
    await prisma.stealthEndpointCredential.count({ where: { variantId: failureCheckpoint.variantId } }),
    1,
  );
  assert.ok(conflictingBuildId);
  const orphanBuildReport = await getStealthExperimentReport(generationEvaluation.id);
  const orphanBuildPrompt = cohortPrompts.find(
    (prompt) => prompt.slug === persistenceFailurePrompt,
  );
  assert.ok(orphanBuildPrompt);
  assert.equal(
    orphanBuildReport?.variants
      .find((variant) => variant.id === failureCheckpoint.variantId)
      ?.builds.find((build) => build.promptId === orphanBuildPrompt.prompt.id)?.status,
    "FAILED",
    "an unaccepted persisted build must not hide its failed result",
  );
  const cleanupRaceRun = await startStealthGeneration(
    memberActor,
    organization.id,
    failureCheckpoint.variantId,
    { maxAttempts: 1, concurrency: 1 },
    async (runId) => `workflow-${runId}`,
  );
  const conflictingBuild = await prisma.build.findUniqueOrThrow({
    where: { id: conflictingBuildId },
    select: { promptId: true },
  });
  const cleanupBarrier = await installBuildDeleteBarrier({
    name: `cleanup_${suffix}`,
    lockKey: Number.parseInt(suffix, 16) + 2,
    buildId: conflictingBuildId,
  });
  const cleanup = deleteUnacceptedStealthBuild(conflictingBuildId);
  await cleanupBarrier.waitUntilBlocked();
  const adoption = prisma.stealthGenerationResult.update({
    where: {
      runId_promptId: { runId: cleanupRaceRun.runId, promptId: conflictingBuild.promptId },
    },
    data: { buildId: conflictingBuildId, status: "READY" },
  });
  adoption.catch(() => undefined);
  try {
    let adoptionSettled = false;
    adoption.finally(() => {
      adoptionSettled = true;
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(adoptionSettled, false, "replacement adoption must wait for cleanup ownership");
    await cleanupBarrier.release();
    assert.equal(await cleanup, true);
    await assert.rejects(adoption);
  } finally {
    await cleanupBarrier.release().catch(() => undefined);
    await cleanup.catch(() => undefined);
    await adoption.catch(() => undefined);
    await cleanupBarrier.uninstall();
  }
  await failStealthGenerationRun(cleanupRaceRun.runId, "Cleanup fencing test complete");
  assert.equal(await prisma.build.count({ where: { id: conflictingBuildId } }), 0);

  const partialRun = await startStealthGeneration(
    memberActor,
    organization.id,
    failureCheckpoint.variantId,
    { maxAttempts: 2, concurrency: 1 },
    async (runId) => `workflow-${runId}`,
  );
  global.fetch = (async () =>
    Response.json({
      choices: [
        { message: { content: JSON.stringify({ version: "1.0", blocks: generatedBlocks }) } },
      ],
    })) as typeof fetch;
  try {
    await generateStealthPromptForRun({
      runId: partialRun.runId,
      promptSlug: validationFailurePrompt,
    });
  } finally {
    global.fetch = originalGenerationFetch;
  }
  await failStealthGenerationRun(partialRun.runId, "Workflow execution failed");
  await failStealthGenerationRun(partialRun.runId, "A duplicate failure must be ignored");
  const partialFailure = await prisma.stealthGenerationRun.findUniqueOrThrow({
    where: { id: partialRun.runId },
  });
  assert.equal(partialFailure.status, "PARTIAL");
  assert.equal(partialFailure.completedBuildCount, 1);
  assert.equal(partialFailure.failedBuildCount, 14);
  assert.equal(partialFailure.providerCallCount, 1);
  assert.equal(partialFailure.retryCount, 0);
  assert.match(partialFailure.error ?? "", /Workflow execution failed/);
  assert.equal(
    await prisma.stealthEndpointCredential.count({ where: { variantId: failureCheckpoint.variantId } }),
    1,
  );

  const reuseRun = await startStealthGeneration(
    memberActor,
    organization.id,
    failureCheckpoint.variantId,
    { maxAttempts: 2, concurrency: 1 },
    async (runId) => `workflow-${runId}`,
  );
  const reusePrompt = cohortPrompts.find((prompt) => prompt.slug === validationFailurePrompt);
  assert.ok(reusePrompt);
  const retryReport = await getStealthExperimentReport(generationEvaluation.id);
  const retryBuild = retryReport?.variants
    .find((variant) => variant.id === failureCheckpoint.variantId)
    ?.builds.find((build) => build.promptId === reusePrompt.prompt.id);
  assert.equal(retryBuild?.status, "READY");
  assert.ok(retryBuild?.resultId, "a retry must retain the inspectable persisted build result");
  assert.equal(
    (
      await prisma.stealthGenerationResult.findUniqueOrThrow({
        where: {
          runId_promptId: { runId: reuseRun.runId, promptId: reusePrompt.prompt.id },
        },
      })
    ).status,
    "QUEUED",
    "persisted builds must be revalidated before a retry accepts them",
  );
  global.fetch = (async () => {
    throw new Error("A completed prompt must not call the provider again");
  }) as typeof fetch;
  try {
    await generateStealthPromptForRun({
      runId: reuseRun.runId,
      promptSlug: validationFailurePrompt,
    });
  } finally {
    global.fetch = originalGenerationFetch;
  }
  const reusedResult = await prisma.stealthGenerationResult.findUniqueOrThrow({
    where: {
      runId_promptId: { runId: reuseRun.runId, promptId: reusePrompt.prompt.id },
    },
    include: { build: { select: { generationTimeMs: true } } },
  });
  assert.equal(reusedResult.status, "READY");
  assert.equal(
    reusedResult.generationTimeMs,
    reusedResult.build?.generationTimeMs,
    "reused evaluation results should retain the original build generation time",
  );
  await failStealthGenerationRun(reuseRun.runId, "Test cleanup");
  await disableStealthEndpoint(memberActor, organization.id, failureCheckpoint.variantId);
  const disabledPartialVariant = await prisma.stealthVariant.findUniqueOrThrow({
    where: { id: failureCheckpoint.variantId },
  });
  assert.equal(disabledPartialVariant.status, "WITHDRAWN");
  assert.equal(disabledPartialVariant.endpointEnabled, false);
  assert.equal(
    await prisma.stealthEndpointCredential.count({ where: { variantId: failureCheckpoint.variantId } }),
    0,
  );

  const reservedUploadEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Reserved upload ${suffix}`,
  });
  const uploadBarrier = await installBuildInsertBarrier({
    name: `upload_${suffix}`,
    lockKey: Number.parseInt(suffix, 16) + 1,
  });
  const reservedUploadPromise = completeUploadedStealthCohort(
    memberActor,
    organization.id,
    reservedUploadEvaluation.id,
    {
      codename: "Reserved upload",
      builds: cohortPrompts.map((prompt) => ({
        promptSlug: prompt.slug,
        build: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
      })),
    },
  );
  let reservedUploadVariant!: { id: string };
  try {
    reservedUploadVariant = await waitFor(
      async () => {
        const variant = await prisma.stealthVariant.findFirst({
          where: {
            experimentId: reservedUploadEvaluation.id,
            generationRuns: { some: { status: "RUNNING" } },
          },
          select: { id: true },
        });
        return variant;
      },
      "upload reservation",
    );
    await assert.rejects(
      configureStealthEndpoint(memberActor, organization.id, reservedUploadEvaluation.id, {
        variantId: reservedUploadVariant.id,
        codename: "Reserved upload",
        config: {
          protocol: "openrouter",
          endpointUrl: "",
          apiKey: "competing-upload-secret-key",
          modelId: `competing-upload-${suffix}`,
          requireStructuredOutput: true,
          enableTools: false,
        },
      }),
      /still running/,
    );
  } finally {
    await uploadBarrier.release();
  }
  let reservedUpload: Awaited<typeof reservedUploadPromise>;
  try {
    reservedUpload = await reservedUploadPromise;
  } finally {
    await uploadBarrier.uninstall();
  }
  assert.equal(reservedUpload.variantId, reservedUploadVariant.id);
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: reservedUpload.runId } }))
      .status,
    "SUCCEEDED",
  );

  const partialUploadEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Partial upload ${suffix}`,
  });
  const partialUploadModel = await prisma.model.create({
    data: {
      key: `partial-upload-${suffix}`,
      provider: "Stealth",
      modelId: `partial-upload-${suffix}`,
      displayName: "Partial upload",
      enabled: false,
    },
  });
  const partialUploadVariant = await prisma.stealthVariant.create({
    data: {
      experimentId: partialUploadEvaluation.id,
      codename: "Partial upload",
      source: "UPLOAD",
      modelId: partialUploadModel.id,
      expectedBuildCount: cohortPrompts.length,
    },
  });
  const removePartialUploadFailure = await installBuildInsertFailure({
    name: `partial_upload_${suffix}`,
    modelId: partialUploadModel.id,
    promptId: cohortPrompts[1]!.prompt.id,
    message: "forced partial upload failure",
  });
  try {
    await assert.rejects(
      completeUploadedStealthCohort(memberActor, organization.id, partialUploadEvaluation.id, {
        variantId: partialUploadVariant.id,
        codename: partialUploadVariant.codename,
        builds: cohortPrompts.map((prompt) => ({
          promptSlug: prompt.slug,
          build: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
        })),
      }),
    );
  } finally {
    await removePartialUploadFailure();
  }
  const partialUploadRun = await prisma.stealthGenerationRun.findFirstOrThrow({
    where: { variantId: partialUploadVariant.id },
    orderBy: { startedAt: "desc" },
  });
  assert.equal(partialUploadRun.status, "PARTIAL");
  assert.equal(partialUploadRun.completedBuildCount, 1);
  const partialUploadWorkspace = await getStealthEvaluationWorkspace(
    memberActor,
    organization.id,
    partialUploadEvaluation.id,
  );
  assert.equal(partialUploadWorkspace?.checkpoints[0]?.persistedBuildCount, 1);
  assert.equal(partialUploadWorkspace?.status, "GENERATING");
  await closeStealthEvaluation(memberActor, organization.id, partialUploadEvaluation.id);

  const failedCreateModel = await prisma.model.create({
    data: {
      key: `failed-create-${suffix}`,
      provider: "Stealth",
      modelId: `failed-create-${suffix}`,
      displayName: "Failed create",
      enabled: false,
    },
  });
  const removeFailedCreateFailure = await installBuildInsertFailure({
    name: `failed_create_${suffix}`,
    modelId: failedCreateModel.id,
    message: "forced build creation failure",
  });
  const failedCreateDatabaseUrl = process.env.DATABASE_URL;
  const failedCreateStorageUrl = process.env.SUPABASE_URL;
  const failedCreateStorageKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const failedCreateFetch = global.fetch;
  let failedCreateUploads = 0;
  let failedCreateDeletes = 0;
  const storageProjectRef = "abcdefghijklmnopqrst";
  process.env.DATABASE_URL = `postgresql://postgres@db.${storageProjectRef}.supabase.co:5432/postgres`;
  process.env.SUPABASE_URL = `https://${storageProjectRef}.supabase.co`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "storage-test-key";
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") failedCreateUploads += 1;
    if (init?.method === "DELETE") {
      failedCreateDeletes += 1;
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      persistStealthBuild({
        variantId: randomUUID(),
        modelId: failedCreateModel.id,
        promptSlug: cohortPrompts[0]!.slug,
        promptText: cohortPrompts[0]!.text,
        build: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
        generationTimeMs: 0,
      }),
    );
  } finally {
    global.fetch = failedCreateFetch;
    if (failedCreateDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = failedCreateDatabaseUrl;
    if (failedCreateStorageUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = failedCreateStorageUrl;
    if (failedCreateStorageKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = failedCreateStorageKey;
    await removeFailedCreateFailure();
  }
  assert.equal(failedCreateUploads, 0, "raw storage writes must not precede Build ownership");
  assert.equal(failedCreateDeletes, 0);
  assert.equal(await prisma.build.count({ where: { modelId: failedCreateModel.id } }), 0);
  await prisma.model.delete({ where: { id: failedCreateModel.id } });

  const artifactFencePrompt = await prisma.prompt.create({
    data: { text: `Artifact fence ${suffix}` },
  });
  const artifactFenceModel = await prisma.model.create({
    data: {
      key: `artifact-fence-${suffix}`,
      provider: "Test",
      modelId: `artifact-fence-${suffix}`,
      displayName: "Artifact fence",
      enabled: false,
    },
  });
  const artifactFenceBuild = await prisma.build.create({
    data: {
      promptId: artifactFencePrompt.id,
      modelId: artifactFenceModel.id,
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      voxelData: { version: "1.0", blocks: [{ x: 0, y: 0, z: 0, type: "stone" }] },
      voxelSha256: `artifact-fence-${suffix}`,
      blockCount: 1,
      generationTimeMs: 0,
    },
  });
  const artifactFenceStorageUrl = process.env.SUPABASE_URL;
  const artifactFenceStorageKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const artifactFenceFetch = global.fetch;
  process.env.SUPABASE_URL = "https://storage.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "artifact-fence-key";
  let markArtifactUploadStarted!: () => void;
  let releaseArtifactUpload!: () => void;
  const artifactUploadStarted = new Promise<void>((resolve) => {
    markArtifactUploadStarted = resolve;
  });
  const artifactUploadRelease = new Promise<void>((resolve) => {
    releaseArtifactUpload = resolve;
  });
  let artifactFenceDeletes = 0;
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      markArtifactUploadStarted();
      await artifactUploadRelease;
      return new Response(null, { status: 200 });
    }
    if (init?.method === "DELETE") {
      artifactFenceDeletes += 1;
      return new Response(null, { status: 200 });
    }
    throw new Error("Unexpected artifact fence request");
  }) as typeof fetch;
  const { uploadArenaBuildStreamArtifact } = await import("../../../lib/arena/buildStream");
  const { deleteArenaBuildArtifacts, uploadArenaBuildArtifact } = await import(
    "../../../lib/arena/artifactOwnership"
  );
  const failedOwnershipRef = {
    bucket: "previous-artifacts",
    path: `failed-ownership/${artifactFenceBuild.id}/full.ndjson`,
  };
  const removeOwnershipFailure = await installDeferredArtifactOwnershipFailure(
    `artifact_${suffix}`,
  );
  let failedOwnershipUpload = false;
  const compensatedOwnershipRefs: typeof failedOwnershipRef[] = [];
  try {
    await assert.rejects(
      uploadArenaBuildArtifact(
        artifactFenceBuild.id,
        failedOwnershipRef,
        async () => {
          failedOwnershipUpload = true;
        },
        async (refs) => {
          compensatedOwnershipRefs.push(...refs);
        },
      ),
      /forced artifact ownership commit failure/,
    );
  } finally {
    await removeOwnershipFailure();
  }
  assert.equal(failedOwnershipUpload, true);
  assert.deepEqual(compensatedOwnershipRefs, [failedOwnershipRef]);
  assert.equal(
    await prisma.arenaBuildArtifact.count({
      where: { bucket: failedOwnershipRef.bucket, path: failedOwnershipRef.path },
    }),
    0,
  );
  const artifactUpload = uploadArenaBuildStreamArtifact(
    artifactFenceBuild.id,
    "full",
    artifactFenceBuild.voxelSha256,
    new TextEncoder().encode('{"type":"done"}\n'),
  );
  try {
    await artifactUploadStarted;
    const artifactDeletion = deleteArenaBuildArtifacts({
      retiringBuilds: [artifactFenceBuild],
      survivingChecksums: new Set(),
      deleteStorage: async () => {
        artifactFenceDeletes += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(artifactFenceDeletes, 0, "artifact deletion must wait for the matching upload");
    releaseArtifactUpload();
    await artifactUpload;
    await artifactDeletion;
    assert.equal(artifactFenceDeletes, 1);
    await prisma.build.delete({ where: { id: artifactFenceBuild.id } });
  } finally {
    releaseArtifactUpload();
    await artifactUpload.catch(() => undefined);
    global.fetch = artifactFenceFetch;
    if (artifactFenceStorageUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = artifactFenceStorageUrl;
    if (artifactFenceStorageKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = artifactFenceStorageKey;
  }
  await prisma.model.delete({ where: { id: artifactFenceModel.id } });
  await prisma.prompt.delete({ where: { id: artifactFencePrompt.id } });

  const uploadedEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Uploaded ${suffix}`,
  });
  const prompts = await prepareStealthCohortPrompts();
  const recoveredUploadEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Recovered upload ${suffix}`,
  });
  const recoveredUploadCodename = `Recovered upload ${suffix}`;
  const removeReadyFinalizationFailure = await installOneShotReadyFinalizationFailure({
    name: `upload_ready_${suffix}`,
    codename: recoveredUploadCodename,
  });
  let recoveredUpload: Awaited<ReturnType<typeof completeUploadedStealthCohort>> | null = null;
  try {
    recoveredUpload = await completeUploadedStealthCohort(
      memberActor,
      organization.id,
      recoveredUploadEvaluation.id,
      {
        codename: recoveredUploadCodename,
        builds: prompts.map((prompt) => ({
          promptSlug: prompt.slug,
          build: {
            version: "1.0",
            blocks: [{ x: 0, y: 0, z: 1, type: "stone" }],
          },
        })),
      },
    );
  } finally {
    await removeReadyFinalizationFailure();
  }
  assert.ok(recoveredUpload);
  assert.equal(
    (
      await prisma.stealthGenerationRun.findUniqueOrThrow({
        where: { id: recoveredUpload.runId },
      })
    ).status,
    "SUCCEEDED",
    "a complete upload must remain successful after transient finalization failure",
  );
  assert.equal(
    (
      await prisma.stealthVariant.findUniqueOrThrow({
        where: { id: recoveredUpload.variantId },
      })
    ).status,
    "READY",
  );
  const uploaded = await completeUploadedStealthCohort(
    memberActor,
    organization.id,
    uploadedEvaluation.id,
    {
      codename: "Uploaded One",
      builds: prompts.map((prompt) => ({
        promptSlug: prompt.slug,
        build: {
          version: "1.0",
          blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
        },
      })),
    },
  );
  const uploadedVariant = await prisma.stealthVariant.findUniqueOrThrow({
    where: { id: uploaded.variantId },
  });
  assert.equal(uploadedVariant.source, "UPLOAD");
  assert.equal(uploadedVariant.generatedBuildCount, prompts.length);
  assert.equal(uploadedVariant.status, "READY");
  await completeUploadedStealthCohort(
    memberActor,
    organization.id,
    uploadedEvaluation.id,
    {
      codename: "Uploaded Two",
      builds: prompts.map((prompt) => ({
        promptSlug: prompt.slug,
        build: {
          version: "1.0",
          blocks: [{ x: 1, y: 0, z: 0, type: "stone" }],
        },
      })),
    },
  );
  assert.equal(
    await prisma.stealthVariant.count({ where: { experimentId: uploadedEvaluation.id } }),
    2,
    "checkpoint membership stays open until activation",
  );
  const uploadedRun = await prisma.stealthGenerationRun.findFirstOrThrow({
    where: { variantId: uploaded.variantId, status: "SUCCEEDED" },
  });
  await prisma.stealthGenerationRun.update({
    where: { id: uploadedRun.id },
    data: { promptCohortId: "prompts-v1:stale" },
  });
  const staleUploadWorkspace = await getStealthEvaluationWorkspace(
    memberActor,
    organization.id,
    uploadedEvaluation.id,
  );
  assert.equal(
    staleUploadWorkspace?.checkpoints.find((entry) => entry.id === uploaded.variantId)
      ?.promptCohortCurrent,
    false,
  );
  await assert.rejects(
    activateStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id),
    /outdated prompt cohort/,
  );
  await completeUploadedStealthCohort(memberActor, organization.id, uploadedEvaluation.id, {
    variantId: uploaded.variantId,
    codename: uploadedVariant.codename,
    builds: prompts.map((prompt) => ({
      promptSlug: prompt.slug,
      build: {
        version: "1.0",
        blocks: [{ x: 0, y: 0, z: 0, type: "stone" }],
      },
    })),
  });
  await activateStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id);
  const active = await prisma.stealthExperiment.findUniqueOrThrow({
    where: { id: uploadedEvaluation.id },
  });
  assert.equal(active.status, "ACTIVE");
  assert.ok(active.checkpointSetFrozenAt);
  await assert.rejects(
    configureStealthEndpoint(memberActor, organization.id, uploadedEvaluation.id, {
      codename: "Too Late",
      config: {
        protocol: "openai-compatible",
        endpointUrl: "https://checkpoint.example.test/v1",
        apiKey: "test-secret-key",
        modelId: "checkpoint-late",
        requireStructuredOutput: true,
        enableTools: true,
      },
    }),
    /cannot accept new checkpoints/,
  );
  await assert.rejects(
    updateStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id, {
      name: "Changed after activation",
    }),
    /identity is frozen/,
  );
  await updateStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id, {
    targetDecisiveVotes: 1,
    pauseAtGoal: true,
  });
  await prisma.stealthVariant.updateMany({
    where: { experimentId: uploadedEvaluation.id, status: "ACTIVE" },
    data: { winCount: 1 },
  });
  assert.equal(await reconcileStealthGoalPause(uploadedEvaluation.id), true);
  await assert.rejects(
    resumeStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id),
    /vote goal/i,
  );
  await updateStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id, {
    targetDecisiveVotes: 2,
  });
  await resumeStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id);
  await closeStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id);
  const uploadedClosed = await prisma.stealthExperiment.findUniqueOrThrow({
    where: { id: uploadedEvaluation.id },
  });
  assert.equal(uploadedClosed.status, "CLOSED");
  assert.ok(uploadedClosed.retentionDeleteAt);
  assert.equal(
    (
      await listStealthEvaluationWorkspaces(memberActor, organization.id)
    ).find((evaluation) => evaluation.id === uploadedEvaluation.id)?.checkpointCount,
    2,
    "closed summaries must retain their historical checkpoint count",
  );
  await prisma.$transaction((tx) => syncExperimentReadiness(tx, uploadedEvaluation.id));
  assert.equal(
    (await prisma.stealthExperiment.findUniqueOrThrow({ where: { id: uploadedEvaluation.id } }))
      .status,
    "CLOSED",
    "readiness synchronization must not reopen a closed evaluation",
  );
  assert.equal(
    await prisma.stealthEndpointCredential.count({ where: { variantId: uploaded.variantId } }),
    0,
  );

  const sharedVariant = await prisma.stealthVariant.findUniqueOrThrow({
    where: { id: uploaded.variantId },
    select: { modelId: true },
  });
  const privateBuild = await prisma.build.findFirstOrThrow({
    where: { modelId: sharedVariant.modelId },
    select: {
      id: true,
      promptId: true,
      gridSize: true,
      palette: true,
      mode: true,
      voxelSha256: true,
      blockCount: true,
      generationTimeMs: true,
    },
  });
  assert.ok(privateBuild.voxelSha256);
  const publicModel = await prisma.model.create({
    data: {
      key: `shared-artifact-${suffix}`,
      provider: "Test",
      modelId: `shared-artifact-${suffix}`,
      displayName: "Shared artifact",
    },
  });
  const sharedRawPath = `stealth-builds/v1/${uploaded.variantId}/shared.json.gz`;
  await prisma.build.update({
    where: { id: privateBuild.id },
    data: { voxelStorageBucket: "builds", voxelStoragePath: sharedRawPath },
  });
  const survivingBuild = await prisma.build.create({
    data: {
      promptId: privateBuild.promptId,
      modelId: publicModel.id,
      gridSize: privateBuild.gridSize,
      palette: privateBuild.palette,
      mode: privateBuild.mode,
      voxelStorageBucket: "builds",
      voxelStoragePath: sharedRawPath,
      voxelSha256: privateBuild.voxelSha256,
      blockCount: privateBuild.blockCount,
      generationTimeMs: privateBuild.generationTimeMs,
    },
  });
  const previousSnapshotPath = `arena-snapshot/previous-policy/${privateBuild.id}/full.json`;
  const previousSharedPath = `arena-stream/previous-policy/checksum/${privateBuild.voxelSha256}/full.ndjson`;
  await prisma.arenaBuildArtifact.createMany({
    data: [
      { buildId: privateBuild.id, bucket: "previous-artifacts", path: previousSnapshotPath },
      { buildId: privateBuild.id, bucket: "previous-artifacts", path: previousSharedPath },
      { buildId: survivingBuild.id, bucket: "previous-artifacts", path: previousSharedPath },
    ],
  });
  const trackedUploadPath = `stealth-cohort-uploads/v1/${organization.id}/${uploadedEvaluation.id}/${randomUUID()}.json`;
  await prisma.stealthCohortUpload.create({
    data: {
      id: randomUUID(),
      experimentId: uploadedEvaluation.id,
      bucket: "builds",
      path: trackedUploadPath,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  const dueShared = new Date(Date.now() - 60_000);
  await prisma.stealthExperiment.update({
    where: { id: uploadedEvaluation.id },
    data: { retentionDeleteAt: dueShared },
  });
  assert.equal(
    (await listStealthEvaluationWorkspaces(memberActor, organization.id)).some(
      (evaluation) => evaluation.id === uploadedEvaluation.id,
    ),
    false,
    "expired evaluations must leave organization summaries before physical purge",
  );
  assert.equal(
    (await listStealthEvaluationWorkspaces(minebenchAdmin, organization.id)).some(
      (evaluation) => evaluation.id === uploadedEvaluation.id,
    ),
    true,
    "the MineBench support view remains independently available",
  );
  assert.equal(
    await getStealthEvaluationWorkspace(memberActor, organization.id, uploadedEvaluation.id),
    null,
    "organization workspace reads must expire at the retention deadline",
  );
  assert.equal(
    await getStealthExperimentReport(uploadedEvaluation.id),
    null,
    "retained reports must expire even when purge is delayed",
  );
  const previousStorageUrl = process.env.SUPABASE_URL;
  const previousStorageKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = global.fetch;
  const deletedPaths: string[] = [];
  let deletionRequests = 0;
  let failStorageOnce = true;
  process.env.SUPABASE_URL = "https://storage.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "storage-test-key";
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).includes("/storage/v1/object/list/")) {
      return Response.json([]);
    }
    if (init?.method !== "DELETE" || typeof init.body !== "string") {
      throw new Error("Unexpected storage request");
    }
    const body = JSON.parse(init.body) as { prefixes: string[] };
    deletedPaths.push(...body.prefixes);
    deletionRequests += 1;
    if (failStorageOnce && deletionRequests === 2) {
      failStorageOnce = false;
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const { getArenaBuildStreamArtifactRef } = await import("../../../lib/arena/buildStream");
    const fullArtifact = getArenaBuildStreamArtifactRef(
      privateBuild.id,
      "full",
      privateBuild.voxelSha256,
    );
    const previewArtifact = getArenaBuildStreamArtifactRef(
      privateBuild.id,
      "preview",
      privateBuild.voxelSha256,
    );
    assert.ok(fullArtifact);
    assert.ok(previewArtifact);
    await assert.rejects(
      purgeStealthEvaluationIfDue(uploadedEvaluation.id, new Date()),
      /Storage deletion failed \(503\)/,
    );
    assert.equal(
      await prisma.stealthExperiment.count({ where: { id: uploadedEvaluation.id } }),
      1,
      "storage failure must leave database records retryable",
    );
    assert.equal(await prisma.build.count({ where: { id: privateBuild.id } }), 1);
    assert.equal(await purgeStealthEvaluationIfDue(uploadedEvaluation.id, new Date()), true);
    assert.equal(deletedPaths.includes(fullArtifact.path), false);
    assert.equal(deletedPaths.includes(previewArtifact.path), false);
    assert.equal(deletedPaths.includes(sharedRawPath), false);
    assert.equal(deletedPaths.includes(previousSnapshotPath), true);
    assert.equal(deletedPaths.includes(previousSharedPath), false);
    assert.equal(deletedPaths.includes(trackedUploadPath), true);
  } finally {
    global.fetch = originalFetch;
    if (previousStorageUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousStorageUrl;
    if (previousStorageKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousStorageKey;
  }
  assert.equal(await prisma.build.count({ where: { id: survivingBuild.id } }), 1);

  const retained = await createStealthEvaluation(minebenchAdmin, otherOrganization.id, {
    name: `Retention ${suffix}`,
    retentionDays: 45,
  });
  await configureStealthEndpoint(minebenchAdmin, otherOrganization.id, retained.id, {
    codename: "Inline retained checkpoint",
    config: {
      protocol: "openai-compatible",
      endpointUrl: "https://checkpoint.example.test/v1",
      apiKey: "inline-retained-secret-key",
      modelId: `inline-retained-${suffix}`,
      requireStructuredOutput: true,
      enableTools: true,
    },
  });
  await closeStealthEvaluation(minebenchAdmin, otherOrganization.id, retained.id);
  const closed = await prisma.stealthExperiment.findUniqueOrThrow({ where: { id: retained.id } });
  assert.equal(closed.retentionDays, 45);
  const due = new Date(Date.now() - 60_000);
  await prisma.stealthExperiment.update({
    where: { id: retained.id },
    data: { retentionDeleteAt: due },
  });
  const retainedStorageEnv = {
    url: process.env.SUPABASE_URL,
    publicUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    roleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    secretKey: process.env.SUPABASE_SECRET_KEY,
  };
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
  try {
    assert.equal(await purgeStealthEvaluationIfDue(retained.id, new Date()), true);
  } finally {
    if (retainedStorageEnv.url !== undefined) process.env.SUPABASE_URL = retainedStorageEnv.url;
    if (retainedStorageEnv.publicUrl !== undefined) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = retainedStorageEnv.publicUrl;
    }
    if (retainedStorageEnv.roleKey !== undefined) {
      process.env.SUPABASE_SERVICE_ROLE_KEY = retainedStorageEnv.roleKey;
    }
    if (retainedStorageEnv.secretKey !== undefined) {
      process.env.SUPABASE_SECRET_KEY = retainedStorageEnv.secretKey;
    }
  }
  assert.equal(await purgeStealthEvaluationIfDue(retained.id, new Date()), false);

  const blockedPurge = await createStealthEvaluation(minebenchAdmin, otherOrganization.id, {
    name: `Blocked purge ${suffix}`,
  });
  const blockedCheckpoint = await configureStealthEndpoint(
    minebenchAdmin,
    otherOrganization.id,
    blockedPurge.id,
    {
      codename: "Blocked purge",
      config: {
        protocol: "openai-compatible",
        endpointUrl: "https://checkpoint.example.test/v1",
        apiKey: "blocked-purge-secret-key",
        modelId: `blocked-purge-${suffix}`,
        requireStructuredOutput: true,
        enableTools: true,
      },
    },
  );
  const laterPurge = await createStealthEvaluation(minebenchAdmin, otherOrganization.id, {
    name: `Later purge ${suffix}`,
  });
  const uploadQuotaEvaluation = await createStealthEvaluation(
    minebenchAdmin,
    otherOrganization.id,
    { name: `Upload quota ${suffix}` },
  );
  const quotaUploadIds = Array.from({ length: 20 }, () => randomUUID());
  await prisma.stealthCohortUpload.createMany({
    data: quotaUploadIds.map((id) => ({
      id,
      experimentId: uploadQuotaEvaluation.id,
      bucket: "builds",
      path: `stealth-cohort-uploads/v1/${otherOrganization.id}/${uploadQuotaEvaluation.id}/${id}.json`,
      expiresAt: new Date(Date.now() + 60_000),
    })),
  });
  await assert.rejects(
    createStealthCohortUploadTarget(
      minebenchAdmin,
      otherOrganization.id,
      uploadQuotaEvaluation.id,
    ),
    /Too many pending cohort uploads/,
  );
  await prisma.stealthCohortUpload.deleteMany({ where: { id: { in: quotaUploadIds } } });
  const abandonedUploadEvaluation = await createStealthEvaluation(
    minebenchAdmin,
    otherOrganization.id,
    { name: `Abandoned upload ${suffix}` },
  );
  const abandonedUploadIds = Array.from({ length: 101 }, () => randomUUID());
  await prisma.stealthCohortUpload.createMany({
    data: abandonedUploadIds.map((id) => ({
      id,
      experimentId: abandonedUploadEvaluation.id,
      bucket: "builds",
      path: `stealth-cohort-uploads/v1/${otherOrganization.id}/${abandonedUploadEvaluation.id}/${id}.json`,
      expiresAt: new Date(Date.now() - 60_000),
    })),
  });
  await closeStealthEvaluation(minebenchAdmin, otherOrganization.id, blockedPurge.id);
  await closeStealthEvaluation(minebenchAdmin, otherOrganization.id, laterPurge.id);
  const purgeNow = new Date();
  await prisma.stealthExperiment.update({
    where: { id: blockedPurge.id },
    data: { retentionDeleteAt: new Date(purgeNow.getTime() - 120_000) },
  });
  await prisma.stealthExperiment.update({
    where: { id: laterPurge.id },
    data: { retentionDeleteAt: new Date(purgeNow.getTime() - 60_000) },
  });
  const batchStorageUrl = process.env.SUPABASE_URL;
  const batchStorageKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const batchFetch = global.fetch;
  process.env.SUPABASE_URL = "https://storage.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "storage-test-key";
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (
      init?.method === "POST" &&
      String(input).includes("/storage/v1/object/list/") &&
      String(init.body).includes(blockedCheckpoint.variantId)
    ) {
      return new Response(null, { status: 503 });
    }
    if (init?.method === "POST" && String(input).includes("/storage/v1/object/list/")) {
      return Response.json([]);
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  let batchPurge: Awaited<ReturnType<typeof purgeDueStealthEvaluations>>;
  try {
    batchPurge = await purgeDueStealthEvaluations(minebenchAdmin, { now: purgeNow, limit: 1 });
  } finally {
    global.fetch = batchFetch;
    if (batchStorageUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = batchStorageUrl;
    if (batchStorageKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = batchStorageKey;
  }
  assert.deepEqual(batchPurge.evaluationIds, [laterPurge.id]);
  assert.equal(batchPurge.failures.length, 1);
  assert.equal(batchPurge.failures[0]?.evaluationId, blockedPurge.id);
  assert.equal(await prisma.stealthExperiment.count({ where: { id: blockedPurge.id } }), 1);
  assert.equal(await prisma.stealthExperiment.count({ where: { id: laterPurge.id } }), 0);
  assert.equal(
    await prisma.stealthCohortUpload.count({ where: { id: { in: abandonedUploadIds } } }),
    0,
    "expired upload cleanup must advance beyond its first batch",
  );
  assert.equal(
    await prisma.stealthExperiment.count({ where: { id: abandonedUploadEvaluation.id } }),
    1,
  );

  console.log("private evaluation application service checks passed");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
