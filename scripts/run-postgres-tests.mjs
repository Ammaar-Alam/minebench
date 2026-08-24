import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

const require = createRequire(import.meta.url);
const prismaCliPath = require.resolve("prisma/build/index.js");
const tsxCliPath = require.resolve("tsx/cli");
const schemaName = `minebench_test_${process.pid}_${randomBytes(8).toString("hex")}`;

function validatedBaseUrl() {
  const raw = process.env.MINEBENCH_TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new Error("MINEBENCH_TEST_DATABASE_URL is required for PostgreSQL integration tests");
  }

  const url = new URL(raw);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("MINEBENCH_TEST_DATABASE_URL must be a PostgreSQL URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error("MINEBENCH_TEST_DATABASE_URL must target loopback PostgreSQL");
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error("MINEBENCH_TEST_DATABASE_URL must name a database");
  }
  if (!/^minebench_test_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error("Generated an invalid test schema name");
  }

  url.searchParams.delete("schema");
  return url;
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} exited with status ${result.status ?? "unknown"}`);
  }
}

async function main() {
  const baseUrl = validatedBaseUrl();
  const adminUrl = new URL(baseUrl);
  adminUrl.searchParams.set("schema", "pg_catalog");
  const testUrl = new URL(baseUrl);
  testUrl.searchParams.set("schema", schemaName);
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  let schemaCreated = false;

  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    const env = {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      DIRECT_URL: testUrl.toString(),
      MINEBENCH_TEST_SCHEMA: schemaName,
    };

    run(process.execPath, [prismaCliPath, "migrate", "deploy"], env);
    run(
      process.execPath,
      [
        prismaCliPath,
        "migrate",
        "diff",
        "--exit-code",
        "--from-schema-datasource",
        "prisma/schema.prisma",
        "--to-schema-datamodel",
        "prisma/schema.prisma",
      ],
      env,
    );

    const roots = process.argv.slice(2);
    run(process.execPath, [tsxCliPath, "tests/run.ts", ...(roots.length ? roots : ["tests/integration"])], env);
  } finally {
    try {
      if (schemaCreated) {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      }
    } finally {
      await admin.$disconnect();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
