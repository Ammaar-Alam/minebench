import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const privateTables = [
  "CustomBuild",
  "CustomBuildSecret",
  "CustomBuildJob",
  "CustomBuildArtifact",
  "CustomBuildEvent",
  "CustomBuildStatsDaily",
  "GalleryCandidate",
  "GalleryExample",
  "GalleryVote",
  "GalleryModerationRecord",
  "GalleryVoteBlock",
];

async function main() {
  const schema = process.env.MINEBENCH_TEST_SCHEMA;
  if (!schema) {
    console.log("Gallery PostgreSQL boundary checks require pnpm test:integration");
    return;
  }
  assert.match(schema, /^minebench_test_[a-z0-9_]+$/);

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
  assert.deepEqual(policies, [], "Gallery data must have no browser-facing policies");

  const clientGrants = await db.$queryRaw<Array<{ grantee: string; tableName: string }>>`
    SELECT grantee, table_name AS "tableName"
    FROM information_schema.role_table_grants
    WHERE table_schema = current_schema()
      AND table_name = ANY(${privateTables})
      AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  `;
  assert.deepEqual(clientGrants, [], "browser roles must not retain Gallery-table grants");

  const indexes = await db.$queryRaw<Array<{ name: string }>>`
    SELECT indexname AS name
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = ANY(${[
        "User_publicNicknameNormalized_key",
        "GalleryCandidate_promptKey_key",
        "GalleryVote_candidateId_sessionId_key",
        "GalleryVote_candidateId_userId_key",
      ]})
  `;
  assert.equal(indexes.length, 4, "identity, prompt, and vote uniqueness must be database-enforced");

  console.log("Gallery PostgreSQL boundary checks passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
