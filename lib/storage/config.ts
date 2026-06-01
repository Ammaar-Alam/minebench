export const DEFAULT_BUILD_STORAGE_BUCKET = "builds";
export const LOCAL_BUILD_STORAGE_BUCKET = "__local_fs__";

export type SupabaseStorageConfig = {
  url: string;
  serviceRoleKey: string;
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getSupabaseStorageConfig(): SupabaseStorageConfig {
  const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  if (!url) {
    throw new Error("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) for storage-backed build payloads");
  }
  if (!serviceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY for storage-backed build payloads");
  }

  return { url: trimTrailingSlashes(url), serviceRoleKey };
}

export function hasSupabaseStorageConfig(): boolean {
  const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  return Boolean(url && serviceRoleKey);
}

export function getBuildStorageBucketFromEnv(): string {
  return (process.env.SUPABASE_STORAGE_BUCKET ?? DEFAULT_BUILD_STORAGE_BUCKET).trim();
}

export function normalizeBuildStoragePath(rawPath: string): string {
  return rawPath.replace(/^\/+/, "");
}
