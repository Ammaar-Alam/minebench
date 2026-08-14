import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

// Refreshes the alpha staging database from the production database.
// Reads production from .env (DIRECT_URL) and staging from .env.staging.local
// (STAGING_DIRECT_URL). The restore drops and recreates the staging public
// schema, so --yes is required.

const repoRoot = process.cwd();
const pgDumpBin = process.env.PG_DUMP_BIN ?? "/opt/homebrew/opt/libpq/bin/pg_dump";
const psqlBin = process.env.PSQL_BIN ?? "/opt/homebrew/opt/libpq/bin/psql";
const tmpDumpPath = path.join("/tmp", `minebench-staging-${Date.now()}.sql`);
const sanitizedDumpPath = `${tmpDumpPath}.sanitized`;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertUrl(name, value) {
  if (!value) fail(`Missing ${name}`);
  try {
    return new URL(value);
  } catch {
    fail(`Invalid ${name}`);
  }
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...opts,
  });
  if (result.status !== 0) {
    fail(`${path.basename(command)} failed with exit code ${result.status ?? 1}`);
  }
}

function normalizePostgresUrlForCli(urlString) {
  const url = new URL(urlString);
  url.searchParams.delete("schema");
  return url.toString();
}

function main() {
  if (!process.argv.includes("--yes")) {
    fail(
      "This drops and recreates the staging public schema. Re-run with --yes to confirm.",
    );
  }

  const prodEnv = parseEnvFile(path.join(repoRoot, ".env"));
  const stagingEnv = parseEnvFile(path.join(repoRoot, ".env.staging.local"));

  const prodDirectUrl = prodEnv.DIRECT_URL || prodEnv.DATABASE_URL;
  const stagingDirectUrl = stagingEnv.STAGING_DIRECT_URL;

  const prodUrl = assertUrl("production DIRECT_URL / DATABASE_URL from .env", prodDirectUrl);
  const stagingUrl = assertUrl("STAGING_DIRECT_URL from .env.staging.local", stagingDirectUrl);

  if (["localhost", "127.0.0.1"].includes(prodUrl.hostname)) {
    fail("Refusing to snapshot: .env points at localhost, not the production DB");
  }
  if (stagingUrl.hostname === prodUrl.hostname && stagingUrl.port === prodUrl.port) {
    fail("Refusing to restore: staging host matches the production host");
  }

  console.log(`Production DB host: ${prodUrl.hostname}`);
  console.log(`Staging DB host: ${stagingUrl.hostname}:${stagingUrl.port || "<default>"}`);
  console.log(`Writing temporary snapshot to ${tmpDumpPath}`);

  const normalizedProdUrl = normalizePostgresUrlForCli(prodDirectUrl);
  const normalizedStagingUrl = normalizePostgresUrlForCli(stagingDirectUrl);

  run(pgDumpBin, [
    "--format=plain",
    "--no-owner",
    "--no-privileges",
    "--schema=public",
    "--file",
    tmpDumpPath,
    normalizedProdUrl,
  ]);

  // stream-sanitize: dumps can exceed node's max string length
  const sanitizedFd = fs.openSync(sanitizedDumpPath, "w");
  try {
    const sedResult = spawnSync(
      "sed",
      [
        "-e", "/^SET transaction_timeout = 0;$/d",
        "-e", "/^CREATE SCHEMA public;$/d",
        "-e", "/^ALTER SCHEMA public OWNER TO /d",
        tmpDumpPath,
      ],
      { stdio: ["ignore", sanitizedFd, "inherit"] },
    );
    if (sedResult.status !== 0) {
      fail(`sed failed with exit code ${sedResult.status ?? 1}`);
    }
  } finally {
    fs.closeSync(sanitizedFd);
  }

  run(psqlBin, [
    normalizedStagingUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
  ]);

  run(psqlBin, [
    normalizedStagingUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    sanitizedDumpPath,
  ]);

  console.log("Staging DB refresh complete");
}

try {
  main();
} finally {
  for (const tempPath of [tmpDumpPath, sanitizedDumpPath]) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}
