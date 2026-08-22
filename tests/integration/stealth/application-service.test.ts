import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../../lib/prisma";

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
    configureStealthEndpoint,
    createStealthEvaluation,
    createStealthGenerationRun,
    deleteUnusedDraftEvaluation,
    disableStealthEndpoint,
    failStealthGenerationRun,
    getStealthEvaluationWorkspace,
    getStealthGenerationPlan,
    inviteOrganizationMember,
    pauseStealthEvaluation,
    prepareStealthCohortPrompts,
    purgeStealthEvaluationIfDue,
    removeOrganizationMember,
    resumeStealthEvaluation,
    updateOrganizationMember,
    updateStealthEvaluation,
  } = await import("../../../lib/stealth/service");

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

  await disableStealthEndpoint(memberActor, organization.id, checkpoint.variantId);
  assert.equal(
    await prisma.stealthEndpointCredential.count({ where: { variantId: checkpoint.variantId } }),
    0,
  );
  await deleteUnusedDraftEvaluation(memberActor, organization.id, evaluation.id);
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
        protocol: "openai-compatible",
        endpointUrl: "https://checkpoint.example.test/v1",
        apiKey: "generation-secret-key",
        modelId: `generation-${suffix}`,
        requireStructuredOutput: true,
        enableTools: true,
      },
    },
  );
  const generationRun = await createStealthGenerationRun(
    memberActor,
    organization.id,
    generationCheckpoint.variantId,
    { maxAttempts: 3, concurrency: 3 },
  );
  assert.equal((await getStealthGenerationPlan(generationRun.runId))?.concurrency, 3);
  await assert.rejects(
    createStealthGenerationRun(
      memberActor,
      organization.id,
      generationCheckpoint.variantId,
      { maxAttempts: 3, concurrency: 1 },
    ),
    /already running/,
  );
  await failStealthGenerationRun(generationRun.runId, "Workflow startup failed");
  assert.equal(
    (await prisma.stealthGenerationRun.findUniqueOrThrow({ where: { id: generationRun.runId } }))
      .status,
    "FAILED",
  );
  const retryRun = await createStealthGenerationRun(
    memberActor,
    organization.id,
    generationCheckpoint.variantId,
    { maxAttempts: 3, concurrency: 2 },
  );
  await failStealthGenerationRun(retryRun.runId, "Test cleanup");

  const uploadedEvaluation = await createStealthEvaluation(memberActor, organization.id, {
    name: `Uploaded ${suffix}`,
  });
  const prompts = await prepareStealthCohortPrompts();
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
  await pauseStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id);
  await resumeStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id);
  await closeStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id);
  const uploadedClosed = await prisma.stealthExperiment.findUniqueOrThrow({
    where: { id: uploadedEvaluation.id },
  });
  assert.equal(uploadedClosed.status, "CLOSED");
  assert.ok(uploadedClosed.retentionDeleteAt);
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
  const dueShared = new Date(Date.now() - 60_000);
  await prisma.stealthExperiment.update({
    where: { id: uploadedEvaluation.id },
    data: { retentionDeleteAt: dueShared },
  });
  const previousStorageUrl = process.env.SUPABASE_URL;
  const previousStorageKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = global.fetch;
  const deletedPaths: string[] = [];
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
    assert.equal(await purgeStealthEvaluationIfDue(uploadedEvaluation.id, new Date()), true);
    assert.equal(deletedPaths.includes(fullArtifact.path), false);
    assert.equal(deletedPaths.includes(previewArtifact.path), false);
    assert.equal(deletedPaths.includes(sharedRawPath), false);
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
  await closeStealthEvaluation(minebenchAdmin, otherOrganization.id, retained.id);
  const closed = await prisma.stealthExperiment.findUniqueOrThrow({ where: { id: retained.id } });
  assert.equal(closed.retentionDays, 45);
  const due = new Date(Date.now() - 60_000);
  await prisma.stealthExperiment.update({
    where: { id: retained.id },
    data: { retentionDeleteAt: due },
  });
  assert.equal(await purgeStealthEvaluationIfDue(retained.id, new Date()), true);
  assert.equal(await purgeStealthEvaluationIfDue(retained.id, new Date()), false);

  console.log("private evaluation application service checks passed");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
