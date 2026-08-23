import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const envNames = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "DIRECT_URL",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

function clearEnv() {
  for (const name of envNames) delete process.env[name];
}

async function main() {
  const projectRef = "abcdefghijklmnopqrst";
  clearEnv();
  process.env.SUPABASE_URL = `https://${projectRef}.supabase.co`;
  process.env.SUPABASE_SECRET_KEY = "server-secret";
  process.env.DATABASE_URL =
    `postgresql://postgres@db.${projectRef}.supabase.co:5432/postgres`;

  const { getSupabaseServerConfig } = await import("../../../lib/supabase/config");
  const { getSupabaseStorageConfig } = await import("../../../lib/storage/buildPayload");
  assert.deepEqual(getSupabaseServerConfig(), {
    url: `https://${projectRef}.supabase.co`,
    secretKey: "server-secret",
  });
  const adminSource = readFileSync("lib/supabase/admin.ts", "utf8");
  assert.match(adminSource, /getSupabaseServerConfig/);
  assert.doesNotMatch(adminSource, /getSupabasePublicConfig/);
  assert.deepEqual(getSupabaseStorageConfig(), {
    url: `https://${projectRef}.supabase.co`,
    serviceRoleKey: "server-secret",
  });

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://zyxwvutsrqponmlkjihg.supabase.co";
  await assert.rejects(async () => getSupabaseStorageConfig(), /same Supabase project/i);

  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${projectRef}.supabase.co`;
  process.env.DATABASE_URL =
    "postgresql://postgres@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres";
  await assert.rejects(async () => getSupabaseServerConfig(), /same Supabase project/i);
}

main()
  .finally(() => {
    clearEnv();
    for (const name of envNames) {
      const value = originalEnv[name];
      if (value !== undefined) process.env[name] = value;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
