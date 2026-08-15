import { after, NextResponse } from "next/server";
import { gzipSync } from "node:zlib";
import type { ArenaBuildVariant } from "@/lib/arena/types";
import {
  deriveArenaBuildLoadHints,
  getCachedPreparedArenaBuild,
  getPreparedArenaBuildCoreMetadataUpdate,
  pickBuildVariant,
  prepareArenaBuild,
} from "@/lib/arena/buildArtifacts";
import {
  createArenaBuildSnapshotArtifactSignedUrl,
  ensureArenaBuildSnapshotArtifacts,
  fetchArenaBuildSnapshotArtifact,
} from "@/lib/arena/buildSnapshotArtifacts";
import {
  getArenaBuildMeta,
  getArenaBuildSnapshotFields,
  invalidateArenaBuildMeta,
} from "@/lib/arena/buildMetaCache";
import { prisma } from "@/lib/prisma";
import { ServerTiming } from "@/lib/serverTiming";

export const runtime = "nodejs";

const SNAPSHOT_ARTIFACT_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.ARENA_SNAPSHOT_ARTIFACT_FETCH_TIMEOUT_MS ?? "5000",
  10,
);
const SNAPSHOT_ARTIFACT_FETCH_ENABLED =
  (process.env.ARENA_SNAPSHOT_ARTIFACT_FETCH_ENABLED ?? "1").trim() === "1";
const SNAPSHOT_ARTIFACT_REDIRECT_ENABLED =
  (process.env.ARENA_SNAPSHOT_ARTIFACT_REDIRECT_ENABLED ?? "1").trim() !== "0";
const SNAPSHOT_PREVIEW_ARTIFACT_REDIRECT_ENABLED =
  (process.env.ARENA_SNAPSHOT_PREVIEW_ARTIFACT_REDIRECT_ENABLED ?? "1").trim() !== "0";
const SNAPSHOT_ARTIFACT_SIGN_TIMEOUT_MS = Number.parseInt(
  process.env.ARENA_SNAPSHOT_ARTIFACT_SIGN_TIMEOUT_MS ?? "5000",
  10,
);
const SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC = Number.parseInt(
  process.env.ARENA_SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC ?? "3600",
  10,
);
const JSON_RESPONSE_CACHE_MAX_ENTRIES = Number.parseInt(
  process.env.ARENA_JSON_RESPONSE_CACHE_MAX_ENTRIES ?? "256",
  10,
);
const JSON_RESPONSE_CACHE_MAX_WEIGHT = Number.parseInt(
  process.env.ARENA_JSON_RESPONSE_CACHE_MAX_WEIGHT ?? "600000000",
  10,
);

type CachedJsonResponse = {
  bytes: Uint8Array;
  // which path produced this body, so a cached fallback still reports as one
  source: "db-snapshot" | "live";
  byteWeight: number;
  touchedAt: number;
};

// short process cache avoids rebuilding the same snapshot json
const jsonResponseCache = new Map<string, CachedJsonResponse>();
const jsonResponseInflight = new Map<string, Promise<Uint8Array | null>>();
let jsonResponseCacheWeight = 0;

// shared build metadata cache lives in lib/arena/buildMetaCache so the build
// and stream routes coalesce concurrent metadata reads on the same lambda.

function parseVariant(value: string | null): ArenaBuildVariant {
  return value === "preview" ? "preview" : "full";
}

function isCurrentPersistedSnapshot(
  snapshot: unknown | null | undefined,
  snapshotChecksum: string | null | undefined,
  storedChecksum: string | null,
): boolean {
  if (!snapshot) return false;
  const normalizedSnapshotChecksum = snapshotChecksum?.trim();
  // db snapshots need their own checksum marker
  return Boolean(normalizedSnapshotChecksum && storedChecksum && normalizedSnapshotChecksum === storedChecksum);
}

function pickCurrentPersistedSnapshot(
  row: {
    arenaSnapshotPreview: unknown | null;
    arenaSnapshotPreviewChecksum: string | null;
    arenaSnapshotFull: unknown | null;
    arenaSnapshotFullChecksum: string | null;
  } | null,
  variant: ArenaBuildVariant,
  storedChecksum: string | null,
): unknown | null {
  if (!row) return null;
  if (variant === "preview") {
    return isCurrentPersistedSnapshot(
      row.arenaSnapshotPreview,
      row.arenaSnapshotPreviewChecksum,
      storedChecksum,
    )
      ? row.arenaSnapshotPreview
      : null;
  }
  return isCurrentPersistedSnapshot(row.arenaSnapshotFull, row.arenaSnapshotFullChecksum, storedChecksum)
    ? row.arenaSnapshotFull
    : null;
}

function acceptsGzip(request: Request): boolean {
  return /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "");
}

function jsonBytes(value: unknown, gzip: boolean): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value));
  return gzip ? gzipSync(bytes) : bytes;
}

function buildJsonResponseCacheKey(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  hints: unknown,
  gzip: boolean,
): string | null {
  const normalizedChecksum = checksum?.trim();
  if (!normalizedChecksum) return null;
  return `${buildId}:${variant}:${normalizedChecksum}:${gzip ? "gzip" : "identity"}:${JSON.stringify(hints)}`;
}

function createJsonHeaders(opts: {
  byteLength: number;
  deliveryClass: string;
  source: string;
  gzip: boolean;
}): Headers {
  const headers = new Headers({
    "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(opts.byteLength),
    "x-build-delivery-class": opts.deliveryClass,
    "x-build-source": opts.source,
  });
  if (opts.gzip) {
    headers.set("Content-Encoding", "gzip");
    headers.set("Vary", "Accept-Encoding");
  }
  return headers;
}

function createSignedRedirectCacheControl(ttlSeconds: number): string {
  const ttl = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : 0;
  const sharedMaxAge = Math.max(0, Math.min(300, ttl - 30));
  if (sharedMaxAge <= 0) return "no-store, no-transform";
  return `public, max-age=0, s-maxage=${sharedMaxAge}, no-transform`;
}

function pruneJsonResponseCache() {
  while (
    jsonResponseCache.size > JSON_RESPONSE_CACHE_MAX_ENTRIES ||
    (JSON_RESPONSE_CACHE_MAX_WEIGHT > 0 && jsonResponseCacheWeight > JSON_RESPONSE_CACHE_MAX_WEIGHT)
  ) {
    const oldestKey = jsonResponseCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = jsonResponseCache.get(oldestKey);
    jsonResponseCache.delete(oldestKey);
    if (oldest) jsonResponseCacheWeight -= oldest.byteWeight;
  }
}

function getCachedJsonResponseByKey(key: string): CachedJsonResponse | null {
  const cached = jsonResponseCache.get(key);
  if (!cached) return null;
  cached.touchedAt = Date.now();
  jsonResponseCache.delete(key);
  jsonResponseCache.set(key, cached);
  return cached;
}

function rememberJsonResponseByKey(
  key: string,
  bytes: Uint8Array,
  source: CachedJsonResponse["source"],
) {
  if (bytes.byteLength > JSON_RESPONSE_CACHE_MAX_WEIGHT) return;
  const previous = jsonResponseCache.get(key);
  if (previous) {
    jsonResponseCacheWeight -= previous.byteWeight;
    jsonResponseCache.delete(key);
  }
  jsonResponseCache.set(key, {
    bytes,
    source,
    byteWeight: bytes.byteLength,
    touchedAt: Date.now(),
  });
  jsonResponseCacheWeight += bytes.byteLength;
  pruneJsonResponseCache();
}

function rememberJsonResponse(
  buildId: string,
  variant: ArenaBuildVariant,
  checksum: string | null,
  hints: unknown,
  gzip: boolean,
  bytes: Uint8Array,
  source: CachedJsonResponse["source"],
) {
  const key = buildJsonResponseCacheKey(buildId, variant, checksum, hints, gzip);
  if (!key) return;
  rememberJsonResponseByKey(key, bytes, source);
}

async function getOrCreateJsonResponse(
  key: string,
  source: CachedJsonResponse["source"],
  create: () => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  const cached = getCachedJsonResponseByKey(key);
  if (cached) return cached.bytes;

  const existing = jsonResponseInflight.get(key);
  // share db snapshot serialization across concurrent clients
  if (existing) return existing;

  const promise = (async () => {
    const bytes = await create();
    if (bytes) rememberJsonResponseByKey(key, bytes, source);
    return bytes;
  })();
  jsonResponseInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (jsonResponseInflight.get(key) === promise) {
      jsonResponseInflight.delete(key);
    }
  }
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const controller = new AbortController();
    return fn(controller.signal);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      fn(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ buildId: string }> },
) {
  const timing = new ServerTiming();
  const requestStartedAt = timing.start();
  const { buildId } = await params;
  const url = new URL(request.url);
  const variant = parseVariant(url.searchParams.get("variant"));
  const expectedChecksum = url.searchParams.get("checksum")?.trim() || null;
  const shouldGzip = acceptsGzip(request);
  // pass the client-supplied checksum so the meta cache can detect stale
  // entries left behind by an overwrite import that landed on another lambda
  const buildMeta = await getArenaBuildMeta(buildId, expectedChecksum);

  if (!buildMeta) {
    return NextResponse.json({ error: "Build not found" }, { status: 404 });
  }

  const storedChecksum = buildMeta.voxelSha256?.trim() || null;
  const artifactAllowed =
    SNAPSHOT_ARTIFACT_FETCH_ENABLED &&
    url.searchParams.get("artifact") !== "0" &&
    Boolean(storedChecksum);
  const shellHints = deriveArenaBuildLoadHints({
    blockCount: buildMeta.blockCount,
    voxelByteSize: buildMeta.voxelByteSize,
    voxelCompressedByteSize: buildMeta.voxelCompressedByteSize,
    arenaBuildHints: buildMeta.arenaBuildHints,
  });
  const deliveryClass = variant === "preview" ? shellHints.initialDeliveryClass : shellHints.deliveryClass;
  const canServeSnapshotArtifact =
    url.searchParams.get("artifact") !== "0" &&
    Boolean(storedChecksum) &&
    ((variant === "preview" && SNAPSHOT_PREVIEW_ARTIFACT_REDIRECT_ENABLED) ||
      (variant === "full" &&
        (shellHints.deliveryClass === "snapshot" || shellHints.deliveryClass === "inline")));
  let shouldRequireStreamFallbackOnSnapshotMiss = false;
  if (expectedChecksum && storedChecksum && expectedChecksum !== storedChecksum) {
    return NextResponse.json(
      {
        error: "Build checksum mismatch",
        expectedChecksum,
        actualChecksum: storedChecksum,
      },
      { status: 409 },
    );
  }

  if (
    SNAPSHOT_ARTIFACT_REDIRECT_ENABLED &&
    url.searchParams.get("redirect") !== "0" &&
    canServeSnapshotArtifact
  ) {
    // redirect first so node does not proxy large immutable snapshots
    const requireStreamFallbackOnMiss = variant === "full";
    try {
      const signedUrl = await withTimeout(
        (signal) =>
          createArenaBuildSnapshotArtifactSignedUrl(buildId, variant, storedChecksum, {
            signal,
            expiresInSec: SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC,
          }),
        SNAPSHOT_ARTIFACT_SIGN_TIMEOUT_MS,
        "snapshot artifact sign",
      );
      if (signedUrl) {
        timing.end("total", requestStartedAt);
        const headers = new Headers({
          "Cache-Control": createSignedRedirectCacheControl(SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC),
          Location: signedUrl,
          "x-build-delivery-class": deliveryClass,
          "x-build-source": "artifact-redirect",
        });
        timing.apply(headers);
        return new Response(null, { status: 307, headers });
      }
    } catch {
      // snapshot miss can still use the db snapshot
    }
    if (requireStreamFallbackOnMiss) {
      shouldRequireStreamFallbackOnSnapshotMiss = true;
    }
  }

  const jsonCacheKey = buildJsonResponseCacheKey(
    buildId,
    variant,
    storedChecksum,
    shellHints,
    shouldGzip,
  );
  // storage-first: the checksum-addressed artifact is the canonical snapshot
  try {
    if (artifactAllowed && canServeSnapshotArtifact) {
      const artifactStartedAt = timing.start();
      const artifactBytes = await withTimeout(
        (signal) =>
          fetchArenaBuildSnapshotArtifact(buildId, variant, storedChecksum, { signal }),
        SNAPSHOT_ARTIFACT_FETCH_TIMEOUT_MS,
        "snapshot artifact fetch",
      );
      if (artifactBytes) {
        timing.end("artifact_hit", artifactStartedAt);
        timing.end("total", requestStartedAt);
        // the stored object is gzip; proxying it verbatim to a gzip-capable
        // client keeps snapshot-class fallbacks off the uncompressed path
        const body = shouldGzip ? gzipSync(Buffer.from(artifactBytes)) : artifactBytes;
        const headers = new Headers({
          "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400, no-transform",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(body.byteLength),
          "x-build-delivery-class": deliveryClass,
          "x-build-source": "artifact",
        });
        if (shouldGzip) {
          headers.set("Content-Encoding", "gzip");
          headers.set("Vary", "Accept-Encoding");
        }
        timing.apply(headers);
        return new Response(Buffer.from(body), { headers });
      }
      timing.end("artifact_miss", artifactStartedAt);
    }
  } catch (error) {
    console.warn("arena snapshot artifact fetch failed", error);
  }

  const cachedJsonResponse = jsonCacheKey ? getCachedJsonResponseByKey(jsonCacheKey) : null;
  if (cachedJsonResponse) {
    // a cached fallback body must still report as the fallback it is, or a
    // soak measuring db-fallback traffic reads clean while serving it
    if (cachedJsonResponse.source === "db-snapshot") {
      console.log(`arena snapshot db fallback (build cached) build=${buildId} variant=${variant}`);
    }
    timing.end("total", requestStartedAt);
    const headers = createJsonHeaders({
      byteLength: cachedJsonResponse.bytes.byteLength,
      deliveryClass: variant === "preview" ? shellHints.initialDeliveryClass : shellHints.deliveryClass,
      source: `response-cache:${cachedJsonResponse.source}`,
      gzip: shouldGzip,
    });
    timing.apply(headers);
    return new Response(Buffer.from(cachedJsonResponse.bytes), { headers });
  }


  const persistedResponseBytes = jsonCacheKey
    ? await getOrCreateJsonResponse(jsonCacheKey, "db-snapshot", async () => {
        // snapshot json bodies live outside the meta cache to avoid retaining
        // multi-mb blobs across many buildIds. the response cache covers
        // subsequent identical requests with its own byte-weight cap.
        const snapshotFields = await getArenaBuildSnapshotFields(buildId);
        const persistedSnapshot = pickCurrentPersistedSnapshot(snapshotFields, variant, storedChecksum);
        if (!persistedSnapshot) return null;
        return jsonBytes(
          {
            buildId,
            variant,
            checksum: storedChecksum,
            serverValidated: true,
            buildLoadHints: shellHints,
            voxelBuild: persistedSnapshot,
          },
          shouldGzip,
        );
      })
    : null;
  if (persistedResponseBytes) {
    // fallback hits must reach zero during the soak before columns can drop
    console.log(`arena snapshot db fallback (build) build=${buildId} variant=${variant}`);
    timing.end("total", requestStartedAt);
    const headers = createJsonHeaders({
      byteLength: persistedResponseBytes.byteLength,
      deliveryClass: variant === "preview" ? shellHints.initialDeliveryClass : shellHints.deliveryClass,
      source: "db-snapshot",
      gzip: shouldGzip,
    });
    timing.apply(headers);
    return new Response(Buffer.from(persistedResponseBytes), { headers });
  }

  if (shouldRequireStreamFallbackOnSnapshotMiss) {
    // full snapshot misses should switch to stream, not rebuild inline
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Retry-After": "1",
      "x-build-delivery-class": deliveryClass,
      "x-build-source": "artifact-redirect-miss",
    });
    timing.end("total", requestStartedAt);
    timing.apply(headers);
    return NextResponse.json(
      {
        error: "Full build artifact is still warming. Use stream fallback.",
        retryVia: "stream",
      },
      { status: 503, headers },
    );
  }

  if (variant === "full" && shellHints.deliveryClass === "stream-artifact") {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Retry-After": "1",
      "x-build-delivery-class": shellHints.deliveryClass,
      "x-build-source": "stream-required",
    });
    timing.end("total", requestStartedAt);
    timing.apply(headers);
    return NextResponse.json(
      {
        error: "Build must be loaded through the stream artifact endpoint.",
        retryVia: "stream",
      },
      { status: 503, headers },
    );
  }

  let prepared = getCachedPreparedArenaBuild(buildId, storedChecksum);
  if (!prepared) {
    // live prepare is rare (artifact + db snapshot already missed), so fetching
    // voxelData/storage pointers on demand is fine instead of holding them in cache.
    const build = await prisma.build.findUnique({
      where: { id: buildId },
      select: {
        id: true,
        gridSize: true,
        palette: true,
        blockCount: true,
        voxelByteSize: true,
        voxelCompressedByteSize: true,
        voxelSha256: true,
        voxelData: true,
        voxelStorageBucket: true,
        voxelStoragePath: true,
        voxelStorageEncoding: true,
      },
    });

    const prepareStartedAt = timing.start();
    try {
      if (!build) {
        return NextResponse.json({ error: "Build not found" }, { status: 404 });
      }
      prepared = await prepareArenaBuild(build, { signal: request.signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load build payload";
      return NextResponse.json({ error: message }, { status: 422 });
    }
    timing.end("prepare", prepareStartedAt);
  }

  if (expectedChecksum && expectedChecksum !== prepared.checksum) {
    return NextResponse.json(
      {
        error: "Build checksum mismatch",
        expectedChecksum,
        actualChecksum: prepared.checksum,
      },
      { status: 409 },
    );
  }

  const voxelBuild = pickBuildVariant(prepared, variant);
  after(async () => {
    // write metadata and artifacts off the response path
    console.log(`arena metadata heal (build) build=${prepared.buildId}`);
    const marked = await prisma.build
      .updateMany({
        where: prepared.payloadIdentity,
        data: getPreparedArenaBuildCoreMetadataUpdate(prepared),
      })
      .catch(() => null);
    if (!marked || marked.count === 0) return;
    // drop stale meta cache so the next request sees the freshly written checksum
    invalidateArenaBuildMeta(prepared.buildId);
    await ensureArenaBuildSnapshotArtifacts(prepared);
  });

  const responseBytes = jsonBytes(
    {
      buildId: prepared.buildId,
      variant,
      checksum: prepared.checksum,
      serverValidated: true,
      buildLoadHints: prepared.hints,
      voxelBuild,
    },
    shouldGzip,
  );
  rememberJsonResponse(
    prepared.buildId,
    variant,
    prepared.checksum,
    prepared.hints,
    shouldGzip,
    responseBytes,
    "live",
  );
  timing.end("total", requestStartedAt);
  const headers = createJsonHeaders({
    byteLength: responseBytes.byteLength,
    deliveryClass: variant === "preview" ? prepared.hints.initialDeliveryClass : prepared.hints.deliveryClass,
    source: "live",
    gzip: shouldGzip,
  });
  timing.apply(headers);

  return new Response(Buffer.from(responseBytes), { headers });
}
