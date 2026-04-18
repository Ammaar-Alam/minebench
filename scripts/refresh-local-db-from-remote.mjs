import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

const repoRoot = process.cwd();
const pgDumpBin = "/opt/homebrew/opt/libpq/bin/pg_dump";
const psqlBin = "/opt/homebrew/opt/libpq/bin/psql";
const tmpDumpPath = path.join("/tmp", `minebench-remote-${Date.now()}.sql`);

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

function isManagedMinebenchLocalUrl(url) {
  return (
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.username === "minebench" &&
    decodeURIComponent(url.password) === "minebench" &&
    url.pathname.replace(/^\/+/, "") === "minebench"
  );
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
  const remoteEnv = parseEnvFile(path.join(repoRoot, ".env"));
  const localEnv = parseEnvFile(path.join(repoRoot, ".env.localdb.local"));

  const remoteDirectUrl = remoteEnv.DIRECT_URL || remoteEnv.DATABASE_URL;
  const localDirectUrl = localEnv.DIRECT_URL || localEnv.DATABASE_URL;

  const remoteUrl = assertUrl("remote DIRECT_URL / DATABASE_URL from .env", remoteDirectUrl);
  const localUrl = assertUrl("local DIRECT_URL / DATABASE_URL from .env.localdb.local", localDirectUrl);

  if (["localhost", "127.0.0.1"].includes(remoteUrl.hostname)) {
    fail("Refusing to snapshot: .env points at localhost, not the real remote DB");
  }
  if (!isManagedMinebenchLocalUrl(localUrl)) {
    fail(
      "Refusing to restore: .env.localdb.local must point at the dedicated minebench local database",
    );
  }

  console.log(`Remote DB host: ${remoteUrl.hostname}`);
  console.log(`Local DB host: ${localUrl.hostname}:${localUrl.port || "<default>"}`);
  console.log(`Writing temporary snapshot to ${tmpDumpPath}`);

  const normalizedRemoteDirectUrl = normalizePostgresUrlForCli(remoteDirectUrl);
  const normalizedLocalDirectUrl = normalizePostgresUrlForCli(localDirectUrl);

  run(pgDumpBin, [
    "--format=plain",
    "--no-owner",
    "--no-privileges",
    "--schema=public",
    "--file",
    tmpDumpPath,
    normalizedRemoteDirectUrl,
  ]);

  const sanitizedSql = fs
    .readFileSync(tmpDumpPath, "utf8")
    .replace(/^SET transaction_timeout = 0;\n/gm, "")
    .replace(/^CREATE SCHEMA public;\n/gm, "")
    .replace(/^ALTER SCHEMA public OWNER TO .*;\n/gm, "");
  fs.writeFileSync(tmpDumpPath, sanitizedSql, "utf8");

  run(psqlBin, [
    normalizedLocalDirectUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
  ]);

  run(psqlBin, [
    normalizedLocalDirectUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    tmpDumpPath,
  ]);

  console.log("Local DB refresh complete");
}

try {
  main();
} finally {
  if (fs.existsSync(tmpDumpPath)) {
    fs.unlinkSync(tmpDumpPath);
  }
}
