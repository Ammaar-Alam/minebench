import { gunzipSync } from "node:zlib";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { parseVoxelBuildSpec } from "@/lib/voxel/validate";

export const DEFAULT_BUILD_STORAGE_BUCKET = "builds";

export type BuildStorageRef = {
  bucket: string;
  path: string;
  encoding?: string | null;
  byteSize?: number | null;
  compressedByteSize?: number | null;
  sha256?: string | null;
};

export type BuildPayloadSource = {
  voxelData: unknown | null;
  voxelStorageBucket: string | null;
  voxelStoragePath: string | null;
  voxelStorageEncoding: string | null;
};

type SupabaseStorageConfig = {
  url: string;
  serviceRoleKey: string;
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function encodingWantsGzip(encoding: string | null | undefined): boolean {
  if (!encoding) return false;
  const first = encoding.split(",")[0]?.trim().toLowerCase();
  return first === "gzip" || first === "x-gzip";
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

export function getBuildStorageBucketFromEnv(): string {
  return (process.env.SUPABASE_STORAGE_BUCKET ?? DEFAULT_BUILD_STORAGE_BUCKET).trim();
}

export function normalizeBuildStoragePath(rawPath: string): string {
  return rawPath.replace(/^\/+/, "");
}

export async function fetchStoredBuildBytes(ref: BuildStorageRef): Promise<Uint8Array> {
  const config = getSupabaseStorageConfig();
  const normalizedPath = normalizeBuildStoragePath(ref.path);
  const bucket = ref.bucket.trim();
  if (!bucket) throw new Error("Storage bucket is required");
  if (!normalizedPath) throw new Error("Storage path is required");

  const encodedPath = encodePath(normalizedPath);
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
    },
    cache: "no-store",
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Storage download failed (${resp.status}): ${text || "empty response"}`);
  }

  return new Uint8Array(await resp.arrayBuffer());
}

export function decodeStoredBuildText(bytes: Uint8Array, encoding?: string | null): string {
  const wantsGzip = encodingWantsGzip(encoding);
  const isGzip = hasGzipMagic(bytes);

  if (wantsGzip || isGzip) {
    if (!isGzip) return Buffer.from(bytes).toString("utf-8");
    try {
      return gunzipSync(bytes).toString("utf-8");
    } catch {
      throw new Error("Stored build payload is marked as gzip but failed to decompress");
    }
  }

  return Buffer.from(bytes).toString("utf-8");
}

export async function loadBuildJsonFromStorage(ref: BuildStorageRef): Promise<unknown> {
  const bytes = await fetchStoredBuildBytes(ref);
  const text = decodeStoredBuildText(bytes, ref.encoding);
  const extracted = extractBestVoxelBuildJson(text);
  if (!extracted) {
    throw new Error("Stored build payload does not contain a valid JSON object");
  }
  return extracted;
}

export async function resolveBuildPayload(source: BuildPayloadSource): Promise<unknown> {
  if (source.voxelData) return source.voxelData;

  const bucket = source.voxelStorageBucket ?? "";
  const path = source.voxelStoragePath ?? "";
  if (!bucket || !path) {
    throw new Error("Build is missing both inline voxelData and storage pointer metadata");
  }

  return loadBuildJsonFromStorage({
    bucket,
    path,
    encoding: source.voxelStorageEncoding,
  });
}

export async function resolveBuildSpec(source: BuildPayloadSource) {
  const payload = await resolveBuildPayload(source);
  const spec = parseVoxelBuildSpec(payload);
  if (!spec.ok) {
    throw new Error(`Build payload is invalid: ${spec.error}`);
  }
  return spec.value;
}
