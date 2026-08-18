import type { PreparedArenaBuild } from "@/lib/arena/buildArtifacts";
import { getArenaPreviewTargetBlocks, pickBuildVariant } from "@/lib/arena/buildArtifacts";
import { getArenaDeliveryPolicySignature } from "@/lib/arena/buildDeliveryPolicy";
import type { ArenaBuildVariant } from "@/lib/arena/types";
import {
  getBuildStorageBucketFromEnv,
  getSupabaseStorageConfig,
  hasSupabaseStorageConfig,
} from "@/lib/storage/buildPayload";
import { encodeBinaryArtifact } from "@/lib/arena/binaryArtifact";
import { gunzipSync, gzipSync } from "node:zlib";

const ENCODER = new TextEncoder();

export type ArenaSnapshotArtifactFormat = "json" | "binary";

export function isBinarySnapshotArtifactEnabled(): boolean {
  return ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED;
}

export type ArenaSnapshotArtifactTarget = {
  variant: ArenaBuildVariant;
  format: ArenaSnapshotArtifactFormat;
};

const ARENA_SNAPSHOT_ARTIFACTS_ENABLED = readBoolEnv("ARENA_SNAPSHOT_ARTIFACTS_ENABLED", true);
const ARENA_SNAPSHOT_ARTIFACT_PREFIX = normalizePrefix(
  process.env.ARENA_SNAPSHOT_ARTIFACT_PREFIX ?? "arena-snapshot/v2-gzip",
);
const deliveryPolicySignature = getArenaDeliveryPolicySignature();
// policy key invalidates old artifacts when delivery thresholds change
const ARENA_SNAPSHOT_ARTIFACT_POLICY_KEY = normalizePrefix(
  [
    "inline",
    deliveryPolicySignature.inlineMaxBytes,
    "snapshot",
    deliveryPolicySignature.snapshotMaxBytes,
    "artifact",
    deliveryPolicySignature.artifactMinBytes,
    "preview-trigger",
    deliveryPolicySignature.previewTriggerBytes,
    "preview-target",
    getArenaPreviewTargetBlocks(),
  ].join("-"),
);
// Binary artifacts are written alongside the JSON ones and read only when a
// client asks for them, so this can be turned on to backfill before anything
// reads it, and turned off without stranding a client on a format it cannot get.
const ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED = readBoolEnv(
  "ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED",
  false,
);
const ARENA_SNAPSHOT_ARTIFACT_BUCKET =
  process.env.ARENA_SNAPSHOT_ARTIFACT_BUCKET?.trim() || getBuildStorageBucketFromEnv();
const ARENA_SNAPSHOT_ARTIFACT_MISS_TTL_MS = readIntEnv(
  "ARENA_SNAPSHOT_ARTIFACT_MISS_TTL_MS",
  1_000,
  1_000,
  60 * 60 * 1000,
);
const ARENA_SNAPSHOT_ARTIFACT_SIGN_REDIRECTS_ENABLED = readBoolEnv(
  "ARENA_SNAPSHOT_ARTIFACT_SIGN_REDIRECTS_ENABLED",
  true,
);
const ARENA_SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC = readIntEnv(
  "ARENA_SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC",
  3600,
  15,
  3600,
);
const SNAPSHOT_BODY_CACHE_MAX_ENTRIES = readIntEnv(
  "ARENA_SNAPSHOT_ARTIFACT_BODY_CACHE_MAX_ENTRIES",
  64,
  8,
  512,
);
const SNAPSHOT_BODY_CACHE_MAX_BYTES = readIntEnv(
  "ARENA_SNAPSHOT_ARTIFACT_BODY_CACHE_MAX_BYTES",
  96_000_000,
  1_000_000,
  1_000_000_000,
);
const ARENA_SNAPSHOT_ARTIFACT_CACHE_CONTROL =
  process.env.ARENA_SNAPSHOT_ARTIFACT_CACHE_CONTROL ?? "public, max-age=31536000, immutable";

type ArenaBuildSnapshotArtifactRef = {
  bucket: string;
  path: string;
};

type SnapshotArtifactPayload = {
  buildId: string;
  variant: ArenaBuildVariant;
  checksum: string | null;
  serverValidated: true;
  buildLoadHints: PreparedArenaBuild["hints"];
  voxelBuild: ReturnType<typeof pickBuildVariant>;
};

const artifactMissCache = new Map<string, number>();
const artifactSignedUrlCache = new Map<string, { url: string; expiresAt: number }>();
const artifactSignedUrlInflight = new Map<string, Promise<string | null>>();
const artifactBodyCache = new Map<string, { bytes: Uint8Array; byteWeight: number; touchedAt: number }>();
const artifactBodyInflight = new Map<string, Promise<Uint8Array | null>>();
const snapshotArtifactUploadInflight = new Map<string, Promise<void>>();
const ARTIFACT_MISS_CACHE_PRUNE_INTERVAL = 256;
let artifactMissCacheTouches = 0;

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

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

function getArtifactCacheKey(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  format: ArenaSnapshotArtifactFormat = "json",
): string {
  return `${buildId}:${variant}:${checksum?.trim() || "none"}:${format}`;
}

function maybePruneArtifactCaches(now: number): void {
  // prune lazily so hot artifact checks stay cheap
  artifactMissCacheTouches += 1;
  if (artifactMissCacheTouches < ARTIFACT_MISS_CACHE_PRUNE_INTERVAL) return;
  artifactMissCacheTouches = 0;

  for (const [key, expiresAt] of artifactMissCache) {
    if (expiresAt <= now) {
      artifactMissCache.delete(key);
    }
  }

  for (const [key, entry] of artifactSignedUrlCache) {
    if (entry.expiresAt <= now) {
      artifactSignedUrlCache.delete(key);
    }
  }

  let bodyCacheBytes = 0;
  for (const entry of artifactBodyCache.values()) {
    bodyCacheBytes += entry.byteWeight;
  }
  if (
    artifactBodyCache.size <= SNAPSHOT_BODY_CACHE_MAX_ENTRIES &&
    bodyCacheBytes <= SNAPSHOT_BODY_CACHE_MAX_BYTES
  ) {
    return;
  }

  const orderedBodies = Array.from(artifactBodyCache.entries()).sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [key, entry] of orderedBodies) {
    if (
      artifactBodyCache.size <= SNAPSHOT_BODY_CACHE_MAX_ENTRIES &&
      bodyCacheBytes <= SNAPSHOT_BODY_CACHE_MAX_BYTES
    ) {
      break;
    }
    artifactBodyCache.delete(key);
    bodyCacheBytes -= entry.byteWeight;
  }
}

function hasFreshArtifactMiss(cacheKey: string): boolean {
  const now = Date.now();
  maybePruneArtifactCaches(now);
  const expiresAt = artifactMissCache.get(cacheKey);
  if (!expiresAt) return false;
  if (expiresAt <= now) {
    artifactMissCache.delete(cacheKey);
    return false;
  }
  return true;
}

function rememberSnapshotArtifactMiss(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  format: ArenaSnapshotArtifactFormat = "json",
): void {
  const now = Date.now();
  maybePruneArtifactCaches(now);
  artifactMissCache.set(
    getArtifactCacheKey(buildId, variant, checksum, format),
    now + ARENA_SNAPSHOT_ARTIFACT_MISS_TTL_MS,
  );
}

function clearSnapshotArtifactMiss(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  format: ArenaSnapshotArtifactFormat = "json",
): void {
  artifactMissCache.delete(getArtifactCacheKey(buildId, variant, checksum, format));
}

function getCachedSnapshotArtifactBody(cacheKey: string): Uint8Array | null {
  const cached = artifactBodyCache.get(cacheKey);
  if (!cached) return null;
  cached.touchedAt = Date.now();
  return cached.bytes;
}

function setCachedSnapshotArtifactBody(cacheKey: string, bytes: Uint8Array): void {
  artifactBodyCache.set(cacheKey, {
    bytes,
    byteWeight: Math.max(1, bytes.byteLength),
    touchedAt: Date.now(),
  });
  maybePruneArtifactCaches(Date.now());
}

function isSnapshotArtifactEnabled(): boolean {
  return Boolean(
    ARENA_SNAPSHOT_ARTIFACTS_ENABLED &&
      ARENA_SNAPSHOT_ARTIFACT_PREFIX &&
      ARENA_SNAPSHOT_ARTIFACT_BUCKET &&
      hasSupabaseStorageConfig(),
  );
}

// The binary artifact sits beside the JSON one under the same checksum, so the
// two never shadow each other and a client that cannot read the binary form
// still finds the object it expects.
export function getSnapshotArtifactRef(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  format: ArenaSnapshotArtifactFormat = "json",
): ArenaBuildSnapshotArtifactRef | null {
  const normalizedChecksum = checksum?.trim();
  if (!normalizedChecksum || !isSnapshotArtifactEnabled()) return null;
  if (format === "binary" && !ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED) return null;
  return {
    bucket: ARENA_SNAPSHOT_ARTIFACT_BUCKET,
    path:
      `${ARENA_SNAPSHOT_ARTIFACT_PREFIX}/${ARENA_SNAPSHOT_ARTIFACT_POLICY_KEY}/` +
      `${buildId}/${variant}-${normalizedChecksum}` +
      (format === "binary" ? ".mbv4" : ".json"),
  };
}

function createSnapshotArtifactPayload(
  prepared: PreparedArenaBuild,
  variant: ArenaBuildVariant,
): SnapshotArtifactPayload {
  return {
    buildId: prepared.buildId,
    variant,
    checksum: prepared.checksum,
    serverValidated: true,
    buildLoadHints: prepared.hints,
    voxelBuild: pickBuildVariant(prepared, variant),
  };
}

function encodeSnapshotArtifactPayload(payload: SnapshotArtifactPayload): Uint8Array {
  return gzipSync(ENCODER.encode(JSON.stringify(payload)));
}

// same envelope, blocks moved into the binary encoding
function encodeBinarySnapshotArtifactPayload(payload: SnapshotArtifactPayload): Uint8Array {
  const { voxelBuild, ...envelope } = payload;
  return gzipSync(
    encodeBinaryArtifact(
      { ...envelope, version: voxelBuild.version },
      voxelBuild.blocks,
      payload.checksum,
    ),
  );
}

export function expectedSnapshotArtifactTargets(
  prepared: PreparedArenaBuild,
): ArenaSnapshotArtifactTarget[] {
  const previewNeeded =
    prepared.previewBuild.blocks.length < prepared.fullBuild.blocks.length;
  const isSnapshotClass =
    prepared.hints.deliveryClass === "snapshot" ||
    prepared.hints.deliveryClass === "inline";
  const targets: ArenaSnapshotArtifactTarget[] = [];

  // Established JSON delivery remains complete before optional binary work.
  if (previewNeeded) targets.push({ variant: "preview", format: "json" });
  if (isSnapshotClass) targets.push({ variant: "full", format: "json" });

  if (ARENA_BINARY_SNAPSHOT_ARTIFACTS_ENABLED) {
    if (previewNeeded) targets.push({ variant: "preview", format: "binary" });
    // Binary full builds are small enough to serve whole for every class.
    targets.push({ variant: "full", format: "binary" });
  }

  return targets;
}

function maybeGunzipArtifactBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return gunzipSync(Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength));
}

async function uploadSnapshotArtifactVariant(
  prepared: PreparedArenaBuild,
  variant: ArenaBuildVariant,
  format: ArenaSnapshotArtifactFormat = "json",
): Promise<void> {
  const ref = getSnapshotArtifactRef(prepared.buildId, variant, prepared.checksum, format);
  if (!ref) return;

  const uploadKey = `${prepared.buildId}:${variant}:${prepared.checksum}:${format}`;
  const existing = snapshotArtifactUploadInflight.get(uploadKey);
  if (existing) {
    // one upload per build variant is enough
    await existing;
    return;
  }

  const promise = (async () => {
    const config = getSupabaseStorageConfig();
    const encodedPath = encodeStoragePath(ref.path);
    const url = `${config.url}/storage/v1/object/${encodeURIComponent(ref.bucket)}/${encodedPath}`;
    const artifact = createSnapshotArtifactPayload(prepared, variant);
    const payload =
      format === "binary"
        ? encodeBinarySnapshotArtifactPayload(artifact)
        : encodeSnapshotArtifactPayload(artifact);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        "x-upsert": "true",
        "cache-control": ARENA_SNAPSHOT_ARTIFACT_CACHE_CONTROL,
        "Content-Encoding": "gzip",
        "Content-Type":
          format === "binary" ? "application/octet-stream" : "application/json; charset=utf-8",
      },
      body: Buffer.from(payload.buffer as ArrayBuffer, payload.byteOffset, payload.byteLength),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Snapshot artifact upload failed (${resp.status}): ${text || "empty response"}`);
    }

    clearSnapshotArtifactMiss(prepared.buildId, variant, prepared.checksum, format);
  })();

  snapshotArtifactUploadInflight.set(uploadKey, promise);
  try {
    await promise;
  } finally {
    snapshotArtifactUploadInflight.delete(uploadKey);
  }
}

export async function ensureArenaBuildSnapshotArtifacts(
  prepared: PreparedArenaBuild,
): Promise<{ uploaded: number; skipped: boolean }> {
  if (!prepared.checksum || !isSnapshotArtifactEnabled()) {
    return { uploaded: 0, skipped: true };
  }

  const targets = expectedSnapshotArtifactTargets(prepared);
  if (targets.length === 0) {
    return { uploaded: 0, skipped: true };
  }

  let uploaded = 0;
  for (const target of targets) {
    // JSON targets are ordered first, so a later binary failure never removes
    // or prevents the established delivery path. The error still propagates so
    // publication and healing can retry the missing binary object.
    await uploadSnapshotArtifactVariant(prepared, target.variant, target.format);
    uploaded += 1;
  }
  return { uploaded, skipped: false };
}

export async function fetchArenaBuildSnapshotArtifact(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  opts?: { signal?: AbortSignal; format?: ArenaSnapshotArtifactFormat },
): Promise<Uint8Array | null> {
  const format = opts?.format ?? "json";
  const ref = getSnapshotArtifactRef(buildId, variant, checksum, format);
  if (!ref) return null;

  const cacheKey = getArtifactCacheKey(buildId, variant, checksum, format);
  const now = Date.now();
  maybePruneArtifactCaches(now);
  if (hasFreshArtifactMiss(cacheKey)) {
    // recent miss means the db snapshot path should win immediately
    return null;
  }

  const cached = getCachedSnapshotArtifactBody(cacheKey);
  if (cached) {
    return cached;
  }

  const inflight = artifactBodyInflight.get(cacheKey);
  if (inflight) {
    // share supabase reads across concurrent requests
    return inflight;
  }

  const promise = (async () => {
    let config: ReturnType<typeof getSupabaseStorageConfig>;
    try {
      config = getSupabaseStorageConfig();
    } catch {
      return null;
    }

    const encodedPath = encodeStoragePath(ref.path);
    const url = `${config.url}/storage/v1/object/${encodeURIComponent(ref.bucket)}/${encodedPath}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
      },
      cache: "no-store",
      signal: opts?.signal,
    });

    if (resp.ok) {
      const bytes = maybeGunzipArtifactBytes(new Uint8Array(await resp.arrayBuffer()));
      clearSnapshotArtifactMiss(buildId, variant, checksum, format);
      setCachedSnapshotArtifactBody(cacheKey, bytes);
      return bytes;
    }

    const text = await resp.text().catch(() => "");
    const normalized = text.toLowerCase();
    const objectMissing =
      normalized.includes("not_found") ||
      normalized.includes("object not found") ||
      normalized.includes("\"error\":\"not_found\"");
    if (resp.status === 404 || (resp.status === 400 && objectMissing)) {
      rememberSnapshotArtifactMiss(buildId, variant, checksum, format);
      return null;
    }

    throw new Error(`Snapshot artifact fetch failed (${resp.status}): ${text || "empty response"}`);
  })();

  artifactBodyInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    artifactBodyInflight.delete(cacheKey);
  }
}

export async function fetchArenaBuildSnapshotArtifactPayload(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  opts?: { signal?: AbortSignal },
): Promise<SnapshotArtifactPayload | null> {
  const bytes = await fetchArenaBuildSnapshotArtifact(buildId, variant, checksum, opts);
  if (!bytes) return null;
  try {
    const payload = JSON.parse(Buffer.from(bytes).toString("utf8")) as SnapshotArtifactPayload;
    if (payload?.buildId !== buildId || payload.variant !== variant) return null;
    const normalizedChecksum = checksum?.trim() || null;
    if (normalizedChecksum && payload.checksum !== normalizedChecksum) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createArenaBuildSnapshotArtifactSignedUrl(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  opts?: { signal?: AbortSignal; expiresInSec?: number; format?: ArenaSnapshotArtifactFormat },
): Promise<string | null> {
  if (!ARENA_SNAPSHOT_ARTIFACT_SIGN_REDIRECTS_ENABLED) return null;

  const format = opts?.format ?? "json";
  const ref = getSnapshotArtifactRef(buildId, variant, checksum, format);
  if (!ref) return null;

  const cacheKey = getArtifactCacheKey(buildId, variant, checksum, format);
  const now = Date.now();
  maybePruneArtifactCaches(now);
  if (hasFreshArtifactMiss(cacheKey)) {
    return null;
  }

  const cachedSignedUrl = artifactSignedUrlCache.get(cacheKey);
  if (cachedSignedUrl && cachedSignedUrl.expiresAt > now) {
    return cachedSignedUrl.url;
  }

  const inflight = artifactSignedUrlInflight.get(cacheKey);
  if (inflight) {
    // signing the same object repeatedly burns latency
    return inflight;
  }

  const promise = (async () => {
    let config: ReturnType<typeof getSupabaseStorageConfig>;
    try {
      config = getSupabaseStorageConfig();
    } catch {
      return null;
    }

    const expiresInSec =
      typeof opts?.expiresInSec === "number" && Number.isFinite(opts.expiresInSec) && opts.expiresInSec > 0
        ? Math.floor(opts.expiresInSec)
        : ARENA_SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC;
    const encodedPath = encodeStoragePath(ref.path);
    const url = `${config.url}/storage/v1/object/sign/${encodeURIComponent(ref.bucket)}/${encodedPath}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: expiresInSec }),
      cache: "no-store",
      signal: opts?.signal,
    });

    if (resp.ok) {
      const body = (await resp.json()) as { signedURL?: string | null };
      const signedURL = body.signedURL?.trim();
      if (!signedURL) {
        throw new Error("Snapshot artifact signed URL response was missing signedURL");
      }
      const fullUrl = signedURL.startsWith("http") ? signedURL : `${config.url}/storage/v1${signedURL}`;
      clearSnapshotArtifactMiss(buildId, variant, checksum, format);
      artifactSignedUrlCache.set(cacheKey, {
        url: fullUrl,
        expiresAt: now + Math.max(5_000, (expiresInSec - 5) * 1000),
      });
      return fullUrl;
    }

    const text = await resp.text().catch(() => "");
    const normalized = text.toLowerCase();
    const objectMissing =
      normalized.includes("not_found") ||
      normalized.includes("object not found") ||
      normalized.includes("\"error\":\"not_found\"");
    if (resp.status === 404 || (resp.status === 400 && objectMissing)) {
      rememberSnapshotArtifactMiss(buildId, variant, checksum, format);
      return null;
    }

    throw new Error(`Snapshot artifact sign failed (${resp.status}): ${text || "empty response"}`);
  })();

  artifactSignedUrlInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    artifactSignedUrlInflight.delete(cacheKey);
  }
}

// Healing tracked separately from the prepared cache. The prepared cache has no
// TTL, so gating repair on "did we just prepare this" means one failed upload
// is never retried for the life of the process. Keyed by build and checksum so
// a re-import re-arms it; recorded only on success, and also when the policy
// says this build needs no snapshot at all.
const healedSnapshotArtifacts = new Set<string>();

export async function healArenaBuildSnapshotArtifactsOnce(
  prepared: PreparedArenaBuild,
): Promise<void> {
  const checksum = prepared.checksum?.trim();
  if (!checksum) return;
  const key = `${prepared.buildId}:${checksum}`;
  if (healedSnapshotArtifacts.has(key)) return;

  try {
    await ensureArenaBuildSnapshotArtifacts(prepared);
    healedSnapshotArtifacts.add(key);
  } catch (error) {
    // leave the key unset so the next miss retries
    console.warn("arena snapshot artifact heal failed", error);
  }
}
