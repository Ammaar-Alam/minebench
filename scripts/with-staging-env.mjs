import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

// Runs any command against the alpha staging environment by mapping the
// STAGING_* credentials onto the standard variable names the app and scripts
// read. Production values in .env are never consulted for the mapped keys.

const repoRoot = process.cwd();
const envPath = path.join(repoRoot, ".env.staging.local");

if (!fs.existsSync(envPath)) {
  console.error("Missing .env.staging.local. See docs/staging.md.");
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("Usage: node scripts/with-staging-env.mjs <command> [args...]");
  process.exit(1);
}

const staging = dotenv.parse(fs.readFileSync(envPath, "utf8"));

function required(name) {
  const value = staging[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} in .env.staging.local`);
    process.exit(1);
  }
  return value;
}

const directUrl = required("STAGING_DIRECT_URL");
const stagingEnv = {
  DATABASE_URL: staging.STAGING_DATABASE_URL?.trim() || directUrl,
  DIRECT_URL: directUrl,
  SUPABASE_URL: required("STAGING_SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: required("STAGING_SUPABASE_SERVICE_ROLE_KEY"),
  SUPABASE_STORAGE_BUCKET: staging.STAGING_SUPABASE_STORAGE_BUCKET?.trim() || "builds",
  MINEBENCH_SITE_URL: required("STAGING_SITE_URL"),
  // preview deployments are behind Vercel deployment protection
  ...(staging.STAGING_VERCEL_BYPASS_SECRET?.trim()
    ? { VERCEL_AUTOMATION_BYPASS_SECRET: staging.STAGING_VERCEL_BYPASS_SECRET.trim() }
    : {}),
};

console.log(`Running against alpha staging: ${stagingEnv.MINEBENCH_SITE_URL}`);

const [command, ...args] = argv;
const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ...stagingEnv,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
