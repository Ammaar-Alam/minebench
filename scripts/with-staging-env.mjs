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
// The storage sync requires the staging bucket to match production's, because
// restored rows keep production's voxelStorageBucket value. Default to the
// same source bucket here so publishing writes where the refresh populated.
const productionEnvPath = path.join(repoRoot, ".env");
const production = fs.existsSync(productionEnvPath)
  ? dotenv.parse(fs.readFileSync(productionEnvPath, "utf8"))
  : {};
const sourceBucket = production.SUPABASE_STORAGE_BUCKET?.trim() || "builds";

function required(name) {
  const value = staging[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} in .env.staging.local`);
    process.exit(1);
  }
  return value;
}

const directUrl = required("STAGING_DIRECT_URL");
const stagingSupabaseUrl = required("STAGING_SUPABASE_URL");
const stagingServiceRoleKey = required("STAGING_SUPABASE_SERVICE_ROLE_KEY");
const stagingEnv = {
  DATABASE_URL: staging.STAGING_DATABASE_URL?.trim() || directUrl,
  DIRECT_URL: directUrl,
  SUPABASE_URL: stagingSupabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: stagingServiceRoleKey,
  SUPABASE_SECRET_KEY: staging.STAGING_SUPABASE_SECRET_KEY?.trim() || stagingServiceRoleKey,
  NEXT_PUBLIC_SUPABASE_URL: stagingSupabaseUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: required("STAGING_SUPABASE_PUBLISHABLE_KEY"),
  STEALTH_CONFIG_ENCRYPTION_KEY: required("STAGING_STEALTH_CONFIG_ENCRYPTION_KEY"),
  STEALTH_ARENA_SHARE: staging.STAGING_STEALTH_ARENA_SHARE?.trim() || "0",
  SUPABASE_STORAGE_BUCKET: staging.STAGING_SUPABASE_STORAGE_BUCKET?.trim() || sourceBucket,
  MINEBENCH_SITE_URL: required("STAGING_SITE_URL"),
  // the alpha deployment may carry its own branch-scoped ADMIN_TOKEN; without
  // this the child inherits production's and every admin call 401s
  ...(staging.STAGING_ADMIN_TOKEN?.trim()
    ? { ADMIN_TOKEN: staging.STAGING_ADMIN_TOKEN.trim() }
    : {}),
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
