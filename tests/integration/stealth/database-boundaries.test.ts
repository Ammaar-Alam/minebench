import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  invalidateStealthSamplingCache,
  pickStealthMatchup,
} from "../../../lib/stealth/sampling";
import { seedPrivateSamplingFixture } from "../../helpers/privateEvaluationFixtures";

const db = new PrismaClient();
const privateTables = [
  "User",
  "Organization",
  "OrganizationMembership",
  "OrganizationInvitation",
  "StealthExperiment",
  "StealthVariant",
  "StealthEndpointCredential",
  "StealthGenerationRun",
  "StealthGenerationResult",
];

async function main() {
  const schema = process.env.MINEBENCH_TEST_SCHEMA;
  if (!schema) {
    console.log("private evaluation PostgreSQL boundary checks require pnpm test:integration");
    return;
  }
  assert.match(schema ?? "", /^minebench_test_[a-z0-9_]+$/);

  const rlsRows = await db.$queryRaw<Array<{ tableName: string; enabled: boolean }>>`
    SELECT cls.relname AS "tableName", cls.relrowsecurity AS enabled
    FROM pg_class cls
    INNER JOIN pg_namespace namespace ON namespace.oid = cls.relnamespace
    WHERE namespace.nspname = current_schema()
      AND cls.relname = ANY(${privateTables})
  `;
  assert.equal(rlsRows.length, privateTables.length);
  for (const table of privateTables) {
    assert.equal(rlsRows.find((row) => row.tableName === table)?.enabled, true, `${table} must enable RLS`);
  }

  const policies = await db.$queryRaw<Array<{ tableName: string; policyName: string }>>`
    SELECT tablename AS "tableName", policyname AS "policyName"
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = ANY(${privateTables})
  `;
  assert.deepEqual(policies, [], "private evaluation data must have no browser-facing policies");

  const clientGrants = await db.$queryRaw<Array<{ grantee: string; tableName: string }>>`
    SELECT grantee, table_name AS "tableName"
    FROM information_schema.role_table_grants
    WHERE table_schema = current_schema()
      AND table_name = ANY(${privateTables})
      AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  `;
  assert.deepEqual(clientGrants, [], "browser roles must not retain private-table grants");

  const roleValues = await db.$queryRaw<Array<{ value: string }>>`
    SELECT enumlabel AS value
    FROM pg_enum
    INNER JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    INNER JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
    WHERE pg_namespace.nspname = current_schema()
      AND pg_type.typname = 'OrganizationRole'
    ORDER BY enumsortorder
  `;
  assert.deepEqual(roleValues.map(({ value }) => value), ["ADMIN", "MEMBER"]);

  const fixture = await seedPrivateSamplingFixture(db, {
    targetDecisiveVotes: 1,
    pauseAtGoal: true,
  });
  invalidateStealthSamplingCache();
  const selection = await pickStealthMatchup({ publicState: fixture.publicState });
  assert.ok(selection);
  assert.equal(selection.stealthVariantId, fixture.variant.id);
  assert.equal(selection.stealthModel.id, fixture.privateModel.id);
  assert.equal(selection.publicModel.id, fixture.publicModel.id);
  assert.notEqual(selection.stealthModel.id, selection.publicModel.id);

  await db.stealthVariant.update({ where: { id: fixture.variant.id }, data: { winCount: 1 } });
  invalidateStealthSamplingCache();
  assert.equal(
    await pickStealthMatchup({ publicState: fixture.publicState }),
    null,
    "an enforced checkpoint goal must remove the checkpoint from sampling",
  );

  await db.stealthExperiment.update({
    where: { id: fixture.experiment.id },
    data: { pauseAtGoal: false },
  });
  invalidateStealthSamplingCache();
  assert.ok(
    await pickStealthMatchup({ publicState: fixture.publicState }),
    "a progress-only goal must not change sampling eligibility",
  );

  await db.stealthExperiment.update({
    where: { id: fixture.experiment.id },
    data: { status: "PAUSED" },
  });
  invalidateStealthSamplingCache();
  assert.equal(await pickStealthMatchup({ publicState: fixture.publicState }), null);

  const unchangedPublicModel = await db.model.findUniqueOrThrow({ where: { id: fixture.publicModel.id } });
  assert.equal(unchangedPublicModel.eloRating, 1550);
  assert.equal(unchangedPublicModel.shownCount, 0);
  assert.equal(unchangedPublicModel.winCount, 0);

  console.log("private evaluation PostgreSQL boundary checks passed");
}

main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
