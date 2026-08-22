import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const require = createRequire(import.meta.url);
const prismaCliPath = require.resolve("prisma/build/index.js");
const oldMigration = "20260821060000_stealth_evaluations";
const selfServiceMigration = "20260821193000_stealth_self_service";

function baseDatabaseUrl(): URL {
  const raw = process.env.MINEBENCH_TEST_DATABASE_URL?.trim();
  assert.ok(raw, "MINEBENCH_TEST_DATABASE_URL is required");
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(hostname));
  url.searchParams.delete("schema");
  return url;
}

function runMigrations(schemaPath: string, databaseUrl: string) {
  const result = spawnSync(
    process.execPath,
    [prismaCliPath, "migrate", "deploy", "--schema", schemaPath],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "migration deployment must succeed");
}

async function main() {
  if (!process.env.MINEBENCH_TEST_SCHEMA) {
    console.log("private evaluation migration upgrade checks require pnpm test:integration");
    return;
  }
  const suffix = `${process.pid}_${randomBytes(6).toString("hex")}`;
  const schema = `minebench_test_upgrade_${suffix}`;
  assert.match(schema, /^minebench_test_upgrade_[a-z0-9_]+$/);

  const baseUrl = baseDatabaseUrl();
  const adminUrl = new URL(baseUrl);
  adminUrl.searchParams.set("schema", "pg_catalog");
  const upgradeUrl = new URL(baseUrl);
  upgradeUrl.searchParams.set("schema", schema);
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  const legacy = new PrismaClient({ datasourceUrl: upgradeUrl.toString() });
  const tempRoot = mkdtempSync(join(tmpdir(), "minebench-migration-upgrade-"));
  const tempPrisma = join(tempRoot, "prisma");
  const tempMigrations = join(tempPrisma, "migrations");
  let schemaCreated = false;

  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    mkdirSync(tempMigrations, { recursive: true });
    cpSync("prisma/schema.prisma", join(tempPrisma, "schema.prisma"));
    cpSync("prisma/migrations/migration_lock.toml", join(tempMigrations, "migration_lock.toml"));
    for (const migration of readdirSync("prisma/migrations")) {
      if (/^\d/.test(migration) && migration <= oldMigration) {
        cpSync(join("prisma/migrations", migration), join(tempMigrations, migration), {
          recursive: true,
        });
      }
    }
    const schemaPath = join(tempPrisma, "schema.prisma");
    runMigrations(schemaPath, upgradeUrl.toString());

    await legacy.$executeRawUnsafe(`
      INSERT INTO "User" (id, email, "updatedAt") VALUES
        ('11111111-1111-4111-8111-111111111111', 'owner@example.test', NOW()),
        ('22222222-2222-4222-8222-222222222222', 'analyst@example.test', NOW())
    `);
    await legacy.$executeRawUnsafe(`
      INSERT INTO "Organization" (id, slug, name, "updatedAt")
      VALUES ('legacy-org', 'legacy-org', 'Legacy Organization', NOW())
    `);
    await legacy.$executeRawUnsafe(`
      INSERT INTO "OrganizationMembership" ("organizationId", "userId", role, "updatedAt") VALUES
        ('legacy-org', '11111111-1111-4111-8111-111111111111', 'OWNER', NOW()),
        ('legacy-org', '22222222-2222-4222-8222-222222222222', 'ANALYST', NOW())
    `);
    await legacy.$executeRawUnsafe(`
      INSERT INTO "OrganizationInvitation" (id, "organizationId", email, role, "updatedAt")
      VALUES ('legacy-invite', 'legacy-org', 'viewer@example.test', 'VIEWER', NOW())
    `);
    await legacy.$executeRawUnsafe(`
      INSERT INTO "Model" (id, key, provider, "modelId", "displayName", "updatedAt")
      VALUES ('legacy-model', 'legacy-private', 'Stealth', 'legacy-private', 'Orchid', NOW())
    `);
    await legacy.$executeRawUnsafe(`
      INSERT INTO "StealthExperiment" (
        id, "organizationId", slug, name, status, "targetDecisiveVotes", "startsAt", "updatedAt"
      ) VALUES (
        'legacy-active', 'legacy-org', 'legacy-active', 'Legacy active', 'STABLE', 321,
        '2026-08-01T00:00:00Z', NOW()
      )
    `);
    await legacy.$executeRawUnsafe(`
      INSERT INTO "StealthExperiment" (
        id, "organizationId", slug, name, status, "targetDecisiveVotes", "endedAt",
        "retentionDeleteAt", "updatedAt"
      ) VALUES (
        'legacy-closed', 'legacy-org', 'legacy-closed', 'Legacy closed', 'CLOSED', 1000,
        '2026-08-01T00:00:00Z', '2026-09-15T00:00:00Z', NOW()
      )
    `);
    await legacy.$executeRawUnsafe(`
      INSERT INTO "StealthVariant" (
        id, "experimentId", codename, status, "modelId", "updatedAt"
      ) VALUES ('legacy-variant', 'legacy-active', 'Orchid', 'RELEASED', 'legacy-model', NOW())
    `);

    cpSync(
      join("prisma/migrations", selfServiceMigration),
      join(tempMigrations, selfServiceMigration),
      { recursive: true },
    );
    runMigrations(schemaPath, upgradeUrl.toString());

    const memberships = await legacy.$queryRaw<Array<{ email: string; role: string }>>`
      SELECT users.email, memberships.role::text AS role
      FROM "OrganizationMembership" memberships
      INNER JOIN "User" users ON users.id = memberships."userId"
      ORDER BY users.email
    `;
    assert.deepEqual(memberships, [
      { email: "analyst@example.test", role: "MEMBER" },
      { email: "owner@example.test", role: "ADMIN" },
    ]);

    const invitation = await legacy.$queryRaw<Array<{ role: string }>>`
      SELECT role::text AS role FROM "OrganizationInvitation" WHERE id = 'legacy-invite'
    `;
    assert.deepEqual(invitation, [{ role: "MEMBER" }]);

    const evaluations = await legacy.$queryRaw<
      Array<{
        id: string;
        status: string;
        target: number | null;
        pauseAtGoal: boolean;
        retentionDays: number;
        frozen: boolean;
      }>
    >`
      SELECT
        id,
        status::text AS status,
        "targetDecisiveVotes" AS target,
        "pauseAtGoal",
        "retentionDays",
        "checkpointSetFrozenAt" IS NOT NULL AS frozen
      FROM "StealthExperiment"
      ORDER BY id
    `;
    assert.deepEqual(evaluations, [
      {
        id: "legacy-active",
        status: "ACTIVE",
        target: 321,
        pauseAtGoal: false,
        retentionDays: 30,
        frozen: true,
      },
      {
        id: "legacy-closed",
        status: "CLOSED",
        target: 1000,
        pauseAtGoal: false,
        retentionDays: 45,
        frozen: true,
      },
    ]);

    const variant = await legacy.$queryRaw<Array<{ status: string; source: string }>>`
      SELECT status::text AS status, source::text AS source
      FROM "StealthVariant"
      WHERE id = 'legacy-variant'
    `;
    assert.deepEqual(variant, [{ status: "WITHDRAWN", source: "ENDPOINT" }]);

    console.log("private evaluation migration upgrade checks passed");
  } finally {
    await legacy.$disconnect();
    try {
      if (schemaCreated) {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await admin.$disconnect();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
