import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

// Refreshes the alpha staging database from the production database.
// Reads production from .env (DIRECT_URL) and staging from .env.staging.local
// (STAGING_DIRECT_URL). The restore drops and recreates the staging public
// schema, so --yes is required.

const repoRoot = process.cwd();
const pgDumpBin = process.env.PG_DUMP_BIN ?? "/opt/homebrew/opt/libpq/bin/pg_dump";
const psqlBin = process.env.PSQL_BIN ?? "/opt/homebrew/opt/libpq/bin/psql";
// A production dump must not be world-readable while the refresh runs, and
// deleting it afterwards does not undo that exposure. mkdtemp creates the
// directory as 0700 for this user only, and the files inside are opened 0600.
const tmpDumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minebench-staging-"));
const tmpDumpPath = path.join(tmpDumpDir, "production.sql");
const sanitizedDumpPath = path.join(tmpDumpDir, "production.sanitized.sql");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath, "utf8"));
}

class RefreshError extends Error {}

// Throw rather than exit so the finally block still removes the dumps: an
// error path is exactly when a production snapshot must not be left in /tmp
function fail(message) {
  throw new RefreshError(message);
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

// Supabase exposes one project through a direct host and a shared regional
// pooler host, so hostnames alone cannot decide identity. Mirrors
// supabaseProjectRefFromDatabaseUrl in lib/db/identity.ts, which a plain .mjs
// script cannot import.
function supabaseProjectRef(url) {
  const user = decodeURIComponent(url.username || "");
  const pooled = user.match(/^postgres\.([a-z0-9]{16,})$/i);
  if (pooled) return pooled[1].toLowerCase();
  const direct = url.hostname.match(/^db\.([a-z0-9]{16,})\.supabase\.(co|com|net)$/i);
  return direct ? direct[1].toLowerCase() : null;
}

// Equivalent spellings of one endpoint must not read as different hosts, or
// the guard below waves through a DROP SCHEMA against production
function canonicalEndpoint(url) {
  return {
    host: url.hostname.trim().toLowerCase().replace(/\.$/, ""),
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\/+/, "")).toLowerCase(),
  };
}

function sameDatabaseEndpoint(a, b) {
  // the project ref survives the direct/pooled difference, so a production
  // project named through either endpoint is recognized as production
  const leftRef = supabaseProjectRef(a);
  const rightRef = supabaseProjectRef(b);
  if (leftRef && rightRef) return leftRef === rightRef;

  const left = canonicalEndpoint(a);
  const right = canonicalEndpoint(b);
  return (
    left.host === right.host && left.port === right.port && left.database === right.database
  );
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
  if (sameDatabaseEndpoint(prodUrl, stagingUrl)) {
    fail("Refusing to restore: staging resolves to the same database endpoint as production");
  }

  console.log(`Production DB host: ${prodUrl.hostname}`);
  console.log(`Staging DB host: ${stagingUrl.hostname}:${stagingUrl.port || "<default>"}`);
  console.log(`Writing temporary snapshot to ${tmpDumpPath}`);

  const normalizedProdUrl = normalizePostgresUrlForCli(prodDirectUrl);
  const normalizedStagingUrl = normalizePostgresUrlForCli(stagingDirectUrl);

  // pre-create the target so pg_dump writes into an owner-only file
  fs.closeSync(fs.openSync(tmpDumpPath, "w", 0o600));
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
  const sanitizedFd = fs.openSync(sanitizedDumpPath, "w", 0o600);
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
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const tempPath of [tmpDumpPath, sanitizedDumpPath]) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
  if (fs.existsSync(tmpDumpDir)) {
    fs.rmSync(tmpDumpDir, { recursive: true, force: true });
  }
}
