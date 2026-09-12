import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import { retryPendingAuthDeletions } from "../../../lib/account/service";
import { getPublicAccount, syncAuthUser } from "../../../lib/auth/account";
import { prisma } from "../../../lib/prisma";

const DELETED_EMAIL_PATTERN = /^[0-9a-f-]+@deleted\.minebench\.invalid$/;

function authUserFixture(id: string, email: string, now: Date): SupabaseAuthUser {
  return {
    id,
    email,
    app_metadata: {},
    user_metadata: { full_name: "Must Not Return" },
    aud: "authenticated",
    created_at: now.toISOString(),
  } satisfies SupabaseAuthUser;
}

async function main() {
  const schema = process.env.MINEBENCH_TEST_SCHEMA;
  if (!schema) {
    console.log("private evaluation member removal checks require pnpm test:integration");
    return;
  }
  assert.match(schema, /^minebench_test_[a-z0-9_]+$/);
  process.env.STEALTH_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  const { removeOrganizationMember } = await import("../../../lib/stealth/service");

  const suffix = randomUUID().slice(0, 8);
  const now = new Date("2026-09-01T12:00:00.000Z");
  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  try {
    const adminA = randomUUID();
    const memberA = randomUUID();
    createdUserIds.push(adminA, memberA);
    await prisma.user.createMany({
      data: [
        { id: adminA, email: `admin-a-${suffix}@example.test` },
        { id: memberA, email: `member-a-${suffix}@example.test` },
      ],
    });
    const orgA = await prisma.organization.create({
      data: {
        name: `Member removal A ${suffix}`,
        slug: `member-removal-a-${suffix}`,
        memberships: {
          create: [
            { userId: adminA, role: "ADMIN" },
            { userId: memberA, role: "MEMBER" },
          ],
        },
      },
    });
    createdOrgIds.push(orgA.id);

    const deletedAuthUsers: string[] = [];
    await removeOrganizationMember(
      { organizationUser: { userId: adminA } },
      orgA.id,
      { email: `member-a-${suffix}@example.test` },
      { now, deleteAuthUser: async (id) => { deletedAuthUsers.push(id); } },
    );
    assert.deepEqual(deletedAuthUsers, [memberA], "orphan cleanup must delete the Supabase Auth identity");

    const tombstoneA = await prisma.user.findUniqueOrThrow({ where: { id: memberA } });
    assert.match(tombstoneA.email, DELETED_EMAIL_PATTERN, "removed member email must be anonymized");
    assert.equal(tombstoneA.deletedAt?.getTime(), now.getTime(), "removed member must be soft-deleted at the injected time");
    assert.equal(tombstoneA.authDeletedAt?.getTime(), now.getTime(), "successful auth deletion must be marked");
    assert.equal(await getPublicAccount(memberA), null, "a removed member must not surface as a public account");
    assert.equal(
      await syncAuthUser(authUserFixture(memberA, `resurrect-a-${suffix}@example.test`, now)),
      null,
      "a removed member must not be reconstituted on sign-in",
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: memberA } })).email,
      tombstoneA.email,
      "a blocked reconstitution must not alter the tombstone email",
    );
    assert.equal(
      await prisma.organizationMembership.count({ where: { userId: memberA } }),
      0,
      "removed member must no longer hold any organization membership",
    );
    assert.equal(
      await prisma.organizationInvitation.count({ where: { email: `member-a-${suffix}@example.test` } }),
      0,
      "all invitations for a removed member's email must be purged",
    );
    assert.equal(
      await prisma.user.count({ where: { id: memberA, deletedAt: { not: null }, authDeletedAt: null } }),
      0,
      "a successfully-deleted auth identity must not appear in the pending-auth-deletion reclaim set",
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: memberA } })).authDeletedAt?.getTime(),
      now.getTime(),
      "a successfully-deleted auth identity must stay marked as auth-deleted",
    );

    const adminB = randomUUID();
    const memberB = randomUUID();
    createdUserIds.push(adminB, memberB);
    await prisma.user.createMany({
      data: [
        { id: adminB, email: `admin-b-${suffix}@example.test` },
        { id: memberB, email: `member-b-${suffix}@example.test` },
      ],
    });
    const orgB = await prisma.organization.create({
      data: {
        name: `Member removal B ${suffix}`,
        slug: `member-removal-b-${suffix}`,
        memberships: {
          create: [
            { userId: adminB, role: "ADMIN" },
            { userId: memberB, role: "MEMBER" },
          ],
        },
      },
    });
    createdOrgIds.push(orgB.id);

    const originalConsoleError = console.error;
    console.error = () => {};
    let failureCallCount = 0;
    try {
      await removeOrganizationMember(
        { organizationUser: { userId: adminB } },
        orgB.id,
        { email: `member-b-${suffix}@example.test` },
        {
          now,
          deleteAuthUser: async () => {
            failureCallCount += 1;
            throw new Error("Auth endpoint temporarily unavailable");
          },
        },
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(failureCallCount, 1, "the auth deletion helper must be invoked exactly once on failure");

    const tombstoneB = await prisma.user.findUniqueOrThrow({ where: { id: memberB } });
    assert.match(tombstoneB.email, DELETED_EMAIL_PATTERN);
    assert.equal(tombstoneB.deletedAt?.getTime(), now.getTime(), "the Prisma row must be soft-deleted even when auth deletion fails");
    assert.equal(tombstoneB.authDeletedAt, null, "a failed auth deletion must leave the tombstone retryable");
    assert.equal(
      await syncAuthUser(authUserFixture(memberB, `resurrect-b-${suffix}@example.test`, now)),
      null,
      "a pending auth-deletion must still block reconstitution on sign-in",
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: memberB } })).email,
      tombstoneB.email,
      "the tombstone email must be untouched after a blocked reconstitution",
    );

    const retriedAuthUsers: string[] = [];
    const retryResult = await retryPendingAuthDeletions({
      now,
      limit: 500,
      deleteAuthUser: async (id) => { retriedAuthUsers.push(id); },
    });
    assert.equal(retryResult.failures, 0, "the retry job must not report failures when auth deletion succeeds");
    assert.equal(
      retriedAuthUsers.includes(memberB),
      true,
      "the pending auth-deletion must be reclaimed by the retry job",
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: memberB } })).authDeletedAt?.getTime(),
      now.getTime(),
      "the retry job must mark the auth identity as deleted",
    );

    const adminC = randomUUID();
    const memberC = randomUUID();
    createdUserIds.push(adminC, memberC);
    await prisma.user.createMany({
      data: [
        { id: adminC, email: `admin-c-${suffix}@example.test` },
        { id: memberC, email: `member-c-${suffix}@example.test` },
      ],
    });
    const [orgC, orgD] = await Promise.all([
      prisma.organization.create({
        data: {
          name: `Member removal C ${suffix}`,
          slug: `member-removal-c-${suffix}`,
          memberships: {
            create: [
              { userId: adminC, role: "ADMIN" },
              { userId: memberC, role: "MEMBER" },
            ],
          },
        },
      }),
      prisma.organization.create({
        data: {
          name: `Member removal D ${suffix}`,
          slug: `member-removal-d-${suffix}`,
          memberships: { create: { userId: memberC, role: "MEMBER" } },
        },
      }),
    ]);
    createdOrgIds.push(orgC.id, orgD.id);

    const memberCAuthCalls: string[] = [];
    await removeOrganizationMember(
      { organizationUser: { userId: adminC } },
      orgC.id,
      { email: `member-c-${suffix}@example.test` },
      { now, deleteAuthUser: async (id) => { memberCAuthCalls.push(id); } },
    );
    assert.deepEqual(memberCAuthCalls, [], "a member with remaining memberships must not trigger auth deletion");
    const survivingMemberC = await prisma.user.findUniqueOrThrow({ where: { id: memberC } });
    assert.equal(survivingMemberC.deletedAt, null, "a member with remaining memberships must not be soft-deleted");
    assert.equal(survivingMemberC.email, `member-c-${suffix}@example.test`, "a member with remaining memberships must keep their email");
    assert.equal(
      await prisma.organizationMembership.count({ where: { organizationId: orgC.id, userId: memberC } }),
      0,
      "the removed member's membership must be deleted from the target organization",
    );
    assert.equal(
      (await prisma.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId: orgD.id, userId: memberC } },
      }))?.role,
      "MEMBER",
      "a remaining membership in another organization must be preserved",
    );

    const adminE = randomUUID();
    const globalAdmin = randomUUID();
    createdUserIds.push(adminE, globalAdmin);
    await prisma.user.createMany({
      data: [
        { id: adminE, email: `admin-e-${suffix}@example.test` },
        { id: globalAdmin, email: `global-admin-${suffix}@example.test`, isMineBenchAdmin: true },
      ],
    });
    const orgE = await prisma.organization.create({
      data: {
        name: `Member removal E ${suffix}`,
        slug: `member-removal-e-${suffix}`,
        memberships: {
          create: [
            { userId: adminE, role: "ADMIN" },
            { userId: globalAdmin, role: "MEMBER" },
          ],
        },
      },
    });
    createdOrgIds.push(orgE.id);

    const globalAdminAuthCalls: string[] = [];
    await removeOrganizationMember(
      { organizationUser: { userId: adminE } },
      orgE.id,
      { email: `global-admin-${suffix}@example.test` },
      { now, deleteAuthUser: async (id) => { globalAdminAuthCalls.push(id); } },
    );
    assert.deepEqual(globalAdminAuthCalls, [], "a global MineBench admin must never be orphan-cleaned on member removal");
    const survivingGlobal = await prisma.user.findUniqueOrThrow({ where: { id: globalAdmin } });
    assert.equal(survivingGlobal.deletedAt, null, "a global MineBench admin must not be soft-deleted on member removal");
    assert.equal(survivingGlobal.isMineBenchAdmin, true, "a global MineBench admin must keep their admin flag");
    assert.equal(survivingGlobal.email, `global-admin-${suffix}@example.test`, "a global MineBench admin must keep their email");
    assert.equal(
      await prisma.organizationMembership.count({ where: { organizationId: orgE.id, userId: globalAdmin } }),
      0,
      "the global admin's membership must still be removed from the target organization",
    );

    const soloAdmin = randomUUID();
    createdUserIds.push(soloAdmin);
    await prisma.user.create({ data: { id: soloAdmin, email: `solo-admin-${suffix}@example.test` } });
    const orgF = await prisma.organization.create({
      data: {
        name: `Member removal F ${suffix}`,
        slug: `member-removal-f-${suffix}`,
        memberships: { create: { userId: soloAdmin, role: "ADMIN" } },
      },
    });
    createdOrgIds.push(orgF.id);
    await assert.rejects(
      removeOrganizationMember(
        { organizationUser: { userId: soloAdmin } },
        orgF.id,
        { email: `solo-admin-${suffix}@example.test` },
      ),
      /at least one Admin/,
      "removing the last organization admin must still be rejected",
    );
    assert.equal(
      (await prisma.organizationMembership.count({ where: { organizationId: orgF.id, userId: soloAdmin } })),
      1,
      "a rejected removal must not delete the membership",
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: soloAdmin } })).deletedAt,
      null,
      "a rejected removal must not soft-delete the user",
    );

    console.log("private evaluation member removal auth-cleanup checks passed");
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
