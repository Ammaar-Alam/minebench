import { getSupabaseServerConfig } from "@/lib/supabase/config";

export const DEFAULT_BUILD_STORAGE_BUCKET = "builds";
export const LOCAL_BUILD_STORAGE_BUCKET = "__local_fs__";

export type SupabaseStorageConfig = {
  url: string;
  serviceRoleKey: string;
};

export function getSupabaseStorageConfig(): SupabaseStorageConfig {
  const config = getSupabaseServerConfig();
  return { url: config.url, serviceRoleKey: config.secretKey };
}

export function hasSupabaseStorageConfig(): boolean {
  try {
    getSupabaseStorageConfig();
    return true;
  } catch {
    return false;
  }
}

export function getBuildStorageBucketFromEnv(): string {
  return process.env.SUPABASE_STORAGE_BUCKET?.trim() || DEFAULT_BUILD_STORAGE_BUCKET;
}

export function normalizeBuildStoragePath(rawPath: string): string {
  return rawPath.replace(/^\/+/, "");
}
