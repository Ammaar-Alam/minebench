import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "minebench-push-staging-"));
const names = ["APNS_ENABLED", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY",
  "EMAIL_NOTIFICATIONS_ENABLED", "NOTIFICATION_EMAIL_TEST_RECIPIENT", "CONTACT_SMTP_PASSWORD", "MINEBENCH_ENVIRONMENT"];
const staging = {
  STAGING_DIRECT_URL: "postgresql://minebench:minebench@127.0.0.1:54327/minebench",
  STAGING_SITE_URL: "http://localhost:3000",
  STAGING_SUPABASE_URL: "http://localhost:54321",
  STAGING_SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  STAGING_SUPABASE_PUBLISHABLE_KEY: "test-publishable",
  STAGING_STEALTH_CONFIG_ENCRYPTION_KEY: "test-stealth",
  STAGING_CUSTOM_BUILD_KEY_ENCRYPTION_SECRET: "test-build",
};

try {
  writeFileSync(join(directory, ".env.staging.local"), Object.entries(staging).map(([key, value]) => `${key}=${value}`).join("\n"));
  const result = spawnSync(process.execPath, [
    resolve("scripts/with-staging-env.mjs"), process.execPath, "-e",
    `console.log(JSON.stringify(${JSON.stringify(names)}.map(name => process.env[name])))`,
  ], {
    cwd: directory, encoding: "utf8",
    env: { ...process.env, ...Object.fromEntries(names.map((name) => [name, "production-only"])) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), ["false", "", "", "", "false", "", "", "alpha"]);
  const refresh = readFileSync("scripts/refresh-staging-db.mjs", "utf8");
  for (const table of ["PushDevice", "NotificationPreference", "NotificationDelivery"]) {
    assert.ok(refresh.includes(`--exclude-table-data=public."${table}"`), `${table} must never be cloned into Alpha`);
  }
  console.log("notification staging isolation checks passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
