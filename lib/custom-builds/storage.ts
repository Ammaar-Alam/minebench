import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { assertCustomBuildPublicId } from "@/lib/custom-builds/ids";
import type {
  CustomBuildArtifactDescriptor,
  CustomBuildArtifactKind,
  CustomBuildStorageEncoding,
} from "@/lib/custom-builds/types";
import { getSupabaseStorageConfig, LOCAL_BUILD_STORAGE_BUCKET } from "@/lib/storage/config";

const DEFAULT_CUSTOM_BUILD_STORAGE_BUCKET = "builds";
const DEFAULT_CUSTOM_BUILD_STORAGE_PREFIX = "custom-builds/v1";
const DEFAULT_CUSTOM_BUILD_LOCAL_STORAGE_DIR = ".custom-build-storage";
const DEFAULT_SIGNED_URL_TTL_SEC = 3600;

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizePrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function encodeStoragePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function resolveLocalCustomBuildStorageRoot(): string {
  const base = path.join(process.cwd(), DEFAULT_CUSTOM_BUILD_LOCAL_STORAGE_DIR);
  const configured = process.env.CUSTOM_BUILD_LOCAL_STORAGE_DIR?.trim();
  if (!configured || configured === DEFAULT_CUSTOM_BUILD_LOCAL_STORAGE_DIR) return base;
  const normalized = configured.replaceAll("\\", "/").replace(/^\.\//, "");
  const relative = normalized.startsWith(`${DEFAULT_CUSTOM_BUILD_LOCAL_STORAGE_DIR}/`)
    ? normalized.slice(DEFAULT_CUSTOM_BUILD_LOCAL_STORAGE_DIR.length + 1)
    : normalized;
  if (path.isAbsolute(configured) || relative.split("/").includes("..")) {
    throw new Error("Custom build local storage directory must stay under .custom-build-storage");
  }
  return path.resolve(base, relative);
}

function resolveLocalCustomBuildStoragePath(objectPath: string): string {
  const root = resolveLocalCustomBuildStorageRoot();
  const normalizedPath = objectPath.replace(/^\/+/, "");
  const absolutePath = path.resolve(root, normalizedPath);
  const rootPrefix = `${root}${path.sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootPrefix)) {
    throw new Error("Custom build local storage path escapes storage root");
  }
  return absolutePath;
}

async function writeLocalCustomBuildArtifact(pathname: string, bytes: Uint8Array): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, bytes);
}

async function readLocalCustomBuildArtifact(pathname: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(pathname));
}

function assertSha256(value: string | undefined, label: string): string {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`Invalid ${label} sha256`);
  }
  return value.toLowerCase();
}

export function getCustomBuildStorageBucket(): string {
  return (
    process.env.CUSTOM_BUILD_STORAGE_BUCKET ??
    process.env.SUPABASE_STORAGE_BUCKET ??
    DEFAULT_CUSTOM_BUILD_STORAGE_BUCKET
  ).trim();
}

export function getCustomBuildStoragePrefix(): string {
  return normalizePrefix(process.env.CUSTOM_BUILD_STORAGE_PREFIX ?? DEFAULT_CUSTOM_BUILD_STORAGE_PREFIX);
}

export function getCustomBuildSignedUrlTtlSeconds(): number {
  return readIntEnv(
    "CUSTOM_BUILD_SIGNED_URL_TTL_SEC",
    DEFAULT_SIGNED_URL_TTL_SEC,
    60,
    60 * 60 * 24,
  );
}

export function assertCustomBuildStorageConfigured(): void {
  if (getCustomBuildStorageBucket() === LOCAL_BUILD_STORAGE_BUCKET) return;
  getSupabaseStorageConfig();
}

export function getCustomBuildArtifactDescriptor(kind: CustomBuildArtifactKind): CustomBuildArtifactDescriptor {
  if (kind === "build_json") {
    return {
      kind,
      format: "json.gz",
      contentType: "application/json",
      fileExtension: "json.gz",
      storageFolder: "build",
    };
  }
  if (kind === "preview_json") {
    return {
      kind,
      format: "json.gz",
      contentType: "application/gzip",
      fileExtension: "json.gz",
      storageFolder: "preview",
    };
  }
  if (kind === "preview_mbv4" || kind === "viewer_mbv4") {
    return {
      kind,
      format: "mbv4.gz",
      contentType: "application/gzip",
      fileExtension: "mbv4.gz",
      storageFolder: kind === "preview_mbv4" ? "preview" : "viewer",
    };
  }
  if (kind === "viewer_mbf1") {
    return {
      kind,
      format: "mbf1.gz",
      contentType: "application/gzip",
      fileExtension: "mbf1.gz",
      storageFolder: "viewer",
    };
  }
  if (kind === "preview_svg") {
    return {
      kind,
      format: "svg",
      contentType: "image/svg+xml; charset=utf-8",
      fileExtension: "svg",
      storageFolder: "preview",
    };
  }
  if (kind === "raw_text_debug") {
    return {
      kind,
      format: "txt",
      contentType: "text/plain; charset=utf-8",
      fileExtension: "txt",
      storageFolder: "debug",
    };
  }
  if (kind === "glb") {
    return {
      kind,
      format: "glb",
      contentType: "model/gltf-binary",
      fileExtension: "glb",
      storageFolder: "exports",
    };
  }
  if (kind === "stl") {
    return {
      kind,
      format: "stl",
      contentType: "model/stl",
      fileExtension: "stl",
      storageFolder: "exports",
    };
  }
  return {
    kind,
    format: "schem",
    contentType: "application/octet-stream",
    fileExtension: "schem",
    storageFolder: "exports",
  };
}

export function getCustomBuildArtifactPath(args: {
  publicId: string;
  kind: CustomBuildArtifactKind;
  sha256?: string;
  sourceBuildSha256?: string;
}): string {
  const publicId = assertCustomBuildPublicId(args.publicId);
  const descriptor = getCustomBuildArtifactDescriptor(args.kind);
  const prefix = getCustomBuildStoragePrefix();

  if (args.kind === "build_json") {
    const sha = assertSha256(args.sha256, "build");
    return `${prefix}/${publicId}/${descriptor.storageFolder}/build-${sha}.json.gz`;
  }
  if (args.kind === "preview_json") {
    const sha = assertSha256(args.sha256, "preview");
    return `${prefix}/${publicId}/${descriptor.storageFolder}/preview-${sha}.json.gz`;
  }
  if (
    args.kind === "preview_mbv4" ||
    args.kind === "viewer_mbv4" ||
    args.kind === "viewer_mbf1" ||
    args.kind === "preview_svg"
  ) {
    const sha = assertSha256(args.sha256, args.kind);
    return `${prefix}/${publicId}/${descriptor.storageFolder}/${args.kind}-${sha}.${descriptor.fileExtension}`;
  }
  if (args.kind === "raw_text_debug") {
    const sha = assertSha256(args.sha256, "raw text");
    return `${prefix}/${publicId}/${descriptor.storageFolder}/raw-${sha}.txt`;
  }

  const sourceSha = assertSha256(args.sourceBuildSha256, "source build");
  return `${prefix}/${publicId}/${descriptor.storageFolder}/build-${sourceSha}.${descriptor.fileExtension}`;
}

export type CustomBuildArtifactUpload = {
  bucket?: string;
  path: string;
  bytes: Uint8Array;
  contentType: string;
  encoding?: CustomBuildStorageEncoding;
};

export async function uploadCustomBuildArtifact(args: CustomBuildArtifactUpload): Promise<void> {
  const bucket = (args.bucket ?? getCustomBuildStorageBucket()).trim();
  if (bucket === LOCAL_BUILD_STORAGE_BUCKET) {
    const absolutePath = resolveLocalCustomBuildStoragePath(args.path);
    await writeLocalCustomBuildArtifact(absolutePath, args.bytes);
    return;
  }

  const config = getSupabaseStorageConfig();
  const encodedPath = encodeStoragePath(args.path);
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "x-upsert": "true",
      "Content-Type": args.contentType,
      ...(args.encoding === "gzip" ? { "Content-Encoding": "gzip" } : {}),
    },
    body: args.bytes as unknown as BodyInit,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Custom build artifact upload failed (${resp.status}): ${text || "empty response"}`);
  }
}

export async function createCustomBuildArtifactSignedUrl(args: {
  bucket: string;
  path: string;
  expiresInSec?: number;
  downloadFileName?: string;
}): Promise<string> {
  if (args.bucket.trim() === LOCAL_BUILD_STORAGE_BUCKET) {
    return pathToFileURL(resolveLocalCustomBuildStoragePath(args.path)).toString();
  }

  const config = getSupabaseStorageConfig();
  const expiresIn = args.expiresInSec ?? getCustomBuildSignedUrlTtlSeconds();
  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.storage
    .from(args.bucket)
    .createSignedUrl(
      args.path,
      expiresIn,
      args.downloadFileName ? { download: args.downloadFileName } : undefined,
    );
  if (error || !data.signedUrl) {
    throw new Error(`Custom build artifact sign failed: ${error?.message ?? "missing signed URL"}`);
  }
  return data.signedUrl;
}

export async function deleteCustomBuildArtifact(args: {
  bucket: string;
  path: string;
}): Promise<void> {
  if (args.bucket.trim() === LOCAL_BUILD_STORAGE_BUCKET) {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(resolveLocalCustomBuildStoragePath(args.path));
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }
  const config = getSupabaseStorageConfig();
  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.storage.from(args.bucket).remove([args.path]);
  if (error) throw new Error(`Custom build artifact deletion failed: ${error.message}`);
}

export async function downloadCustomBuildArtifactBytes(args: {
  bucket: string;
  path: string;
}): Promise<Uint8Array> {
  if (args.bucket.trim() === LOCAL_BUILD_STORAGE_BUCKET) {
    return readLocalCustomBuildArtifact(resolveLocalCustomBuildStoragePath(args.path));
  }

  const config = getSupabaseStorageConfig();
  const encodedPath = encodeStoragePath(args.path);
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(args.bucket)}/${encodedPath}`;
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
    throw new Error(`Custom build artifact download failed (${resp.status}): ${text || "empty response"}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
