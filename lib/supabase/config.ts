import {
  supabaseProjectRefFromApiUrl,
  supabaseProjectRefFromDatabaseUrl,
} from "@/lib/db/identity";

export type SupabasePublicConfig = {
  url: string;
  publishableKey: string;
};

export type SupabaseServerConfig = {
  url: string;
  secretKey: string;
};

function trimUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function assertOneSupabaseProject(): void {
  const refs = [
    supabaseProjectRefFromApiUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""),
    supabaseProjectRefFromApiUrl(process.env.SUPABASE_URL ?? ""),
    supabaseProjectRefFromDatabaseUrl(process.env.DATABASE_URL ?? ""),
    supabaseProjectRefFromDatabaseUrl(process.env.DIRECT_URL ?? ""),
  ].filter((ref): ref is string => Boolean(ref));
  if (new Set(refs).size > 1) {
    throw new Error("Supabase Auth, Storage, and Database must target the same Supabase project");
  }
}

export function getSupabasePublicConfig(): SupabasePublicConfig {
  assertOneSupabaseProject();
  const url = trimUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "");
  const publishableKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  if (!url || !publishableKey) {
    throw new Error(
      "Authentication requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  }
  return { url, publishableKey };
}

export function getSupabaseSecretKey(): string {
  const key = (
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    ""
  ).trim();
  if (!key) {
    throw new Error("Supabase admin operations require SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY");
  }
  return key;
}

export function getSupabaseServerConfig(): SupabaseServerConfig {
  assertOneSupabaseProject();
  const url = trimUrl(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!url) throw new Error("Supabase server operations require SUPABASE_URL");
  return { url, secretKey: getSupabaseSecretKey() };
}
