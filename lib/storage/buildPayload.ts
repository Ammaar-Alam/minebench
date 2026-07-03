import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import {
  getSupabaseStorageConfig,
  LOCAL_BUILD_STORAGE_BUCKET,
  normalizeBuildStoragePath,
} from "@/lib/storage/config";
import { parseVoxelBuildSpec } from "@/lib/voxel/validate";

export {
  DEFAULT_BUILD_STORAGE_BUCKET,
  getBuildStorageBucketFromEnv,
  getSupabaseStorageConfig,
  hasSupabaseStorageConfig,
  LOCAL_BUILD_STORAGE_BUCKET,
  normalizeBuildStoragePath,
} from "@/lib/storage/config";

export type BuildStorageRef = {
  bucket: string;
  path: string;
  encoding?: string | null;
  byteSize?: number | null;
  compressedByteSize?: number | null;
  sha256?: string | null;
  blockCount?: number | null;
};

export type BuildPayloadSource = {
  voxelData: unknown | null;
  voxelStorageBucket: string | null;
  voxelStoragePath: string | null;
  voxelStorageEncoding: string | null;
};

type LoadBuildPayloadOptions = {
  signal?: AbortSignal;
};

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function resolveLocalStorageAbsolutePath(rawPath: string): string {
  const normalizedPath = normalizeBuildStoragePath(rawPath);
  if (!normalizedPath) {
    throw new Error("Local storage path is required");
  }

  const repoRoot = path.resolve(process.cwd());
  const absolutePath = path.resolve(repoRoot, normalizedPath);
  const repoPrefix = `${repoRoot}${path.sep}`;
  if (absolutePath !== repoRoot && !absolutePath.startsWith(repoPrefix)) {
    throw new Error("Local storage path escapes repository root");
  }

  return absolutePath;
}

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function encodingWantsGzip(encoding: string | null | undefined): boolean {
  if (!encoding) return false;
  const first = encoding.split(",")[0]?.trim().toLowerCase();
  return first === "gzip" || first === "x-gzip";
}

export async function fetchStoredBuildBytes(
  ref: BuildStorageRef,
  opts?: LoadBuildPayloadOptions,
): Promise<Uint8Array> {
  if (opts?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  if ((ref.bucket ?? "").trim() === LOCAL_BUILD_STORAGE_BUCKET) {
    const absolutePath = resolveLocalStorageAbsolutePath(ref.path);
    return new Uint8Array(await readFile(absolutePath));
  }

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
    signal: opts?.signal,
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

export async function loadBuildJsonFromStorage(
  ref: BuildStorageRef,
  opts?: LoadBuildPayloadOptions,
): Promise<unknown> {
  const bytes = await fetchStoredBuildBytes(ref, opts);
  if (opts?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const text = decodeStoredBuildText(bytes, ref.encoding);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Stored payloads are normally raw JSON; fall back to the more permissive extractor
    // for older artifacts or LLM-style wrappers.
  }
  const extracted = extractBestVoxelBuildJson(text);
  if (!extracted) {
    throw new Error("Stored build payload does not contain a valid JSON object");
  }
  return extracted;
}

export async function resolveBuildPayload(
  source: BuildPayloadSource,
  opts?: LoadBuildPayloadOptions,
): Promise<unknown> {
  if (opts?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
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
  }, opts);
}

export async function resolveBuildSpec(source: BuildPayloadSource, opts?: LoadBuildPayloadOptions) {
  const payload = await resolveBuildPayload(source, opts);
  const spec = parseVoxelBuildSpec(payload);
  if (!spec.ok) {
    throw new Error(`Build payload is invalid: ${spec.error}`);
  }
  return spec.value;
}
