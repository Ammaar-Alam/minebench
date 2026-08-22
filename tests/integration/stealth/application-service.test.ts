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
    activateStealthEvaluation,
    closeStealthEvaluation,
    completeUploadedStealthCohort,
    configureStealthEndpoint,
    createStealthEvaluation,
    deleteUnusedDraftEvaluation,
    disableStealthEndpoint,
    getStealthEvaluationWorkspace,
    pauseStealthEvaluation,
    prepareStealthCohortPrompts,
    purgeStealthEvaluationIfDue,
    removeOrganizationMember,
    resumeStealthEvaluation,
    updateOrganizationMember,
    updateStealthEvaluation,
  } = await import("../../../lib/stealth/service");

  const suffix = randomUUID().slice(0, 8);
  const [admin, member, outsider] = await Promise.all(
    ["admin", "member", "outsider"].map((name) =>
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
  await activateStealthEvaluation(memberActor, organization.id, uploadedEvaluation.id);
  const active = await prisma.stealthExperiment.findUniqueOrThrow({
    where: { id: uploadedEvaluation.id },
  });
  assert.equal(active.status, "ACTIVE");
  assert.ok(active.checkpointSetFrozenAt);
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
