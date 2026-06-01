import { getSupabaseStorageConfig } from "@/lib/storage/buildPayload";
import { assertCustomBuildPublicId } from "@/lib/custom-builds/ids";
import type {
  CustomBuildArtifactDescriptor,
  CustomBuildArtifactKind,
  CustomBuildStorageEncoding,
} from "@/lib/custom-builds/types";

const DEFAULT_CUSTOM_BUILD_STORAGE_BUCKET = "builds";
const DEFAULT_CUSTOM_BUILD_STORAGE_PREFIX = "custom-builds/v1";
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

export function getCustomBuildArtifactDescriptor(kind: CustomBuildArtifactKind): CustomBuildArtifactDescriptor {
  if (kind === "build_json") {
    return {
      kind,
      format: "json.gz",
      contentType: "application/gzip",
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
  const config = getSupabaseStorageConfig();
  const bucket = (args.bucket ?? getCustomBuildStorageBucket()).trim();
  const encodedPath = encodeStoragePath(args.path);
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "x-upsert": "false",
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
}): Promise<string> {
  const config = getSupabaseStorageConfig();
  const encodedPath = encodeStoragePath(args.path);
  const expiresIn = args.expiresInSec ?? getCustomBuildSignedUrlTtlSeconds();
  const url = `${config.url}/storage/v1/object/sign/${encodeURIComponent(args.bucket)}/${encodedPath}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn }),
    cache: "no-store",
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Custom build artifact sign failed (${resp.status}): ${text || "empty response"}`);
  }

  const body = (await resp.json()) as { signedURL?: string | null };
  const signedUrl = body.signedURL?.trim();
  if (!signedUrl) {
    throw new Error("Custom build artifact signed URL response was missing signedURL");
  }
  return signedUrl.startsWith("http") ? signedUrl : `${config.url}/storage/v1${signedUrl}`;
}

export async function downloadCustomBuildArtifactBytes(args: {
  bucket: string;
  path: string;
}): Promise<Uint8Array> {
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
