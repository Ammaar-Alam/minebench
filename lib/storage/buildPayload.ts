import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import { supabaseProjectRefFromApiUrl } from "@/lib/db/identity";
import {
  getBuildStorageBucketFromEnv,
  getSupabaseStorageConfig,
  LOCAL_BUILD_STORAGE_BUCKET,
  normalizeBuildStoragePath,
  type SupabaseStorageConfig,
} from "@/lib/storage/config";
import { parseVoxelBuildSpec } from "@/lib/voxel/validate";

const STORAGE_DELETE_BATCH_SIZE = 100;

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
  maxBytes?: number;
};

export type SupabaseStorageReadiness = {
  projectRef: string | null;
  bucket: string | null;
  ready: boolean;
  error: string | null;
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

export async function deleteSupabaseStorageObjects(
  refs: ReadonlyArray<{ bucket: string; path: string }>,
): Promise<void> {
  if (refs.length === 0) return;
  const config = getSupabaseStorageConfig();
  const byBucket = new Map<string, Set<string>>();
  for (const ref of refs) {
    const paths = byBucket.get(ref.bucket) ?? new Set<string>();
    paths.add(ref.path);
    byBucket.set(ref.bucket, paths);
  }
  for (const [bucket, pathSet] of byBucket) {
    const paths = Array.from(pathSet);
    for (let index = 0; index < paths.length; index += STORAGE_DELETE_BATCH_SIZE) {
      const response = await fetch(
        `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${config.serviceRoleKey}`,
            apikey: config.serviceRoleKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prefixes: paths.slice(index, index + STORAGE_DELETE_BATCH_SIZE) }),
        },
      );
      if (!response.ok) throw new Error(`Storage deletion failed (${response.status})`);
    }
  }
}

export async function uploadSupabaseStorageFile(args: {
  bucket: string;
  path: string;
  filePath: string;
  byteSize: number;
  contentType: string;
  encoding?: string;
}): Promise<void> {
  const { createReadStream } = await import("node:fs");
  const config = getSupabaseStorageConfig();
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(args.bucket)}/${encodePath(args.path)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "x-upsert": "true",
      "Content-Type": args.contentType,
      "Content-Length": String(args.byteSize),
      ...(args.encoding ? { "Content-Encoding": args.encoding } : {}),
    },
    body: createReadStream(args.filePath) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Storage upload failed (${response.status}): ${text || "empty response"}`);
  }
}

export async function createSupabaseSignedUploadToken(args: {
  bucket: string;
  path: string;
}): Promise<string> {
  const config = getSupabaseStorageConfig();
  const response = await fetch(
    `${config.url}/storage/v1/object/upload/sign/${encodeURIComponent(args.bucket)}/${encodePath(args.path)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: "{}",
    },
  );
  if (!response.ok) throw new Error(`Storage upload signing failed (${response.status})`);
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== "string") throw new Error("Storage upload signing returned no URL");
  const token = new URL(body.url, config.url).searchParams.get("token");
  if (!token) throw new Error("Storage upload signing returned no token");
  return token;
}

export async function assertSupabaseStorageObjectExists(args: {
  bucket: string;
  path: string;
}): Promise<void> {
  const config = getSupabaseStorageConfig();
  const response = await fetch(
    `${config.url}/storage/v1/object/info/${encodeURIComponent(args.bucket)}/${encodePath(args.path)}`,
    {
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
      },
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error("Upload did not finish; try again");
}

export async function getSupabaseStorageReadiness(): Promise<SupabaseStorageReadiness> {
  const rawUrl = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const projectRef = rawUrl ? supabaseProjectRefFromApiUrl(rawUrl) : null;
  const bucket = getBuildStorageBucketFromEnv();

  let config: SupabaseStorageConfig;
  try {
    config = getSupabaseStorageConfig();
  } catch (error) {
    return {
      projectRef,
      bucket: bucket || null,
      ready: false,
      error: error instanceof Error ? error.message : "Storage configuration is invalid",
    };
  }
  if (!bucket) {
    return {
      projectRef,
      bucket: null,
      ready: false,
      error: "Missing SUPABASE_STORAGE_BUCKET for storage-backed build payloads",
    };
  }

  try {
    const resp = await fetch(
      `${config.url}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.serviceRoleKey}`,
          apikey: config.serviceRoleKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefix: "", limit: 1, offset: 0 }),
        cache: "no-store",
      },
    );
    if (!resp.ok) {
      return {
        projectRef,
        bucket,
        ready: false,
        error: `Storage list probe failed (${resp.status})`,
      };
    }
    return { projectRef, bucket, ready: true, error: null };
  } catch (error) {
    return {
      projectRef,
      bucket,
      ready: false,
      error: error instanceof Error ? error.message : "Storage list probe failed",
    };
  }
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
    if (opts?.maxBytes != null && (await stat(absolutePath)).size > opts.maxBytes) {
      throw new Error("Storage payload exceeds size limit");
    }
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
  const maxBytes = opts?.maxBytes;
  if (maxBytes == null) {
    return new Uint8Array(await resp.arrayBuffer());
  }
  const contentLength = Number.parseInt(resp.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await resp.body?.cancel().catch(() => undefined);
    throw new Error("Storage payload exceeds size limit");
  }
  if (!resp.body) return new Uint8Array();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Storage payload exceeds size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function decodeStoredBuildText(
  bytes: Uint8Array,
  encoding?: string | null,
  opts?: { maxOutputBytes?: number },
): string {
  const wantsGzip = encodingWantsGzip(encoding);
  const isGzip = hasGzipMagic(bytes);

  if (wantsGzip || isGzip) {
    if (!isGzip) {
      if (opts?.maxOutputBytes != null && bytes.byteLength > opts.maxOutputBytes) {
        throw new Error("Stored build payload exceeds size limit");
      }
      return Buffer.from(bytes).toString("utf-8");
    }
    try {
      return gunzipSync(
        bytes,
        opts?.maxOutputBytes == null ? undefined : { maxOutputLength: opts.maxOutputBytes },
      ).toString("utf-8");
    } catch (error) {
      if (
        opts?.maxOutputBytes != null &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_BUFFER_TOO_LARGE"
      ) {
        throw new Error("Stored build payload exceeds size limit");
      }
      throw new Error("Stored build payload is marked as gzip but failed to decompress");
    }
  }

  if (opts?.maxOutputBytes != null && bytes.byteLength > opts.maxOutputBytes) {
    throw new Error("Stored build payload exceeds size limit");
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
