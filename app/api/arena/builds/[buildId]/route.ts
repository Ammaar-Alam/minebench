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
  isBinarySnapshotArtifactEnabled,
  healArenaBuildSnapshotArtifactsOnce,
  fetchArenaBuildSnapshotArtifact,
  type ArenaSnapshotArtifactFetchMetrics,
} from "@/lib/arena/buildSnapshotArtifacts";
import type { ArenaSnapshotArtifactFormat } from "@/lib/arena/artifactOwnership";
import { rewriteBlindBinaryArtifactIdentity } from "@/lib/arena/binaryArtifact";
import {
  getArenaBuildMeta,
  invalidateArenaBuildMeta,
} from "@/lib/arena/buildMetaCache";
import { parseArenaBuildAccessToken } from "@/lib/arena/matchupToken";
import { isLoopbackDatabaseUrl } from "@/lib/db/identity";
import { prisma } from "@/lib/prisma";
import { ServerTiming } from "@/lib/serverTiming";
import { trackServerEvent } from "@/lib/analytics.server";
import {
  getArenaBlockCountBucket,
  roundMetricMs,
} from "@/lib/observability/arenaMetrics";
import {
  setActiveServerSpanAttributes,
  withServerSpan,
  withServerSpanSync,
} from "@/lib/observability/serverTracing";

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
  // which path produced this body; only live prepares are cached now that
  // snapshots are served from storage
  source: "live";
  byteWeight: number;
  touchedAt: number;
};

type ArenaBuildTimingStage =
  | "token_validate"
  | "artifact_resolve"
  | "artifact_fetch"
  | "inflate"
  | "identity_rewrite"
  | "deflate"
  | "body_ready"
  | "total";

type ArenaBuildDeliveryObservation = {
  access: "blind" | "public";
  variant: ArenaBuildVariant;
  requestedFormat: "v4" | "legacy";
  servedFormat: "binary" | "json" | "ndjson" | "none";
  deliveryClass: string;
  source: string;
  artifactOutcome: string;
  artifactCacheStatus: string;
  fallbackReason: string | null;
  blockCount: number | null;
  responseBytes: number | null;
  transferBytes: number | null;
  decodedBytes: number | null;
  gzip: boolean;
  optimizedExpected: boolean;
  optimizedDelivered: boolean;
};

function logArenaBuildDelivery(
  observation: ArenaBuildDeliveryObservation,
  stages: Partial<Record<ArenaBuildTimingStage, number>>,
  status: number,
) {
  const blockCountBucket = getArenaBlockCountBucket(observation.blockCount);
  const path = [
    observation.variant,
    observation.requestedFormat,
    observation.servedFormat,
    observation.source,
    observation.artifactOutcome,
  ].join(":");
  const roundedStages = {
    tokenValidateMs: roundMetricMs(stages.token_validate),
    artifactResolveMs: roundMetricMs(stages.artifact_resolve),
    artifactFetchMs: roundMetricMs(stages.artifact_fetch),
    inflateMs: roundMetricMs(stages.inflate),
    identityRewriteMs: roundMetricMs(stages.identity_rewrite),
    deflateMs: roundMetricMs(stages.deflate),
    bodyReadyMs: roundMetricMs(stages.body_ready),
    totalMs: roundMetricMs(stages.total),
  };

  console.info(
    JSON.stringify({
      event: "arena_build_delivery",
      status,
      ...observation,
      blockCountBucket,
      ...roundedStages,
    }),
  );

  // Web Analytics Plus accepts at most eight properties per custom event
  after(async () => {
    await trackServerEvent("arena_build_server_timing", {
      path,
      blockCountBucket,
      tokenMs: roundedStages.tokenValidateMs,
      resolveMs: roundedStages.artifactResolveMs,
      bodyReadyMs: roundedStages.bodyReadyMs,
      totalMs: roundedStages.totalMs,
      status,
      optimized: observation.optimizedDelivered,
    });
    if (stages.artifact_fetch != null) {
      await trackServerEvent("arena_artifact_server_timing", {
        path,
        cache: observation.artifactCacheStatus,
        fetchMs: roundedStages.artifactFetchMs,
        inflateMs: roundedStages.inflateMs,
        rewriteMs: roundedStages.identityRewriteMs,
        deflateMs: roundedStages.deflateMs,
        transferBytes: observation.transferBytes,
        decodedBytes: observation.decodedBytes,
      });
    }
  });
}

// short process cache avoids rebuilding the same snapshot json
const jsonResponseCache = new Map<string, CachedJsonResponse>();
let jsonResponseCacheWeight = 0;

// shared build metadata cache lives in lib/arena/buildMetaCache so the build
// and stream routes coalesce concurrent metadata reads on the same lambda.

function parseVariant(value: string | null): ArenaBuildVariant {
  return value === "preview" ? "preview" : "full";
}

function acceptsGzip(request: Request): boolean {
  return /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "");
}

function jsonBytes(value: unknown, gzip: boolean): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value));
  return gzip ? gzipSync(bytes) : bytes;
}

function rewriteBlindSnapshotIdentity(bytes: Uint8Array, buildId: string): Uint8Array {
  const payload = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...payload, buildId, checksum: null }));
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
  privateAccess?: boolean;
}): Headers {
  const headers = new Headers({
    "Cache-Control": opts.privateAccess
      ? "private, no-store"
      : "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
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

function dropCachedJsonResponse(key: string): void {
  const cached = jsonResponseCache.get(key);
  if (!cached) return;
  jsonResponseCache.delete(key);
  jsonResponseCacheWeight -= cached.byteWeight;
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
  const stages: Partial<Record<ArenaBuildTimingStage, number>> = {};
  const url = new URL(request.url);
  const variant = parseVariant(url.searchParams.get("variant"));
  const binaryFormatRequested = url.searchParams.get("format") === "v4";
  const shouldGzip = acceptsGzip(request);
  let observation: ArenaBuildDeliveryObservation = {
    access: "public",
    variant,
    requestedFormat: binaryFormatRequested ? "v4" : "legacy",
    servedFormat: "none",
    deliveryClass: "unknown",
    source: "unknown",
    artifactOutcome: "not-attempted",
    artifactCacheStatus: "not-attempted",
    fallbackReason: null,
    blockCount: null,
    responseBytes: null,
    transferBytes: null,
    decodedBytes: null,
    gzip: shouldGzip,
    optimizedExpected: binaryFormatRequested,
    optimizedDelivered: false,
  };

  const recordStage = (stage: ArenaBuildTimingStage, durationMs: number) => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    stages[stage] = (stages[stage] ?? 0) + durationMs;
    timing.add(stage, durationMs);
  };
  const measureStageSync = <T,>(
    stage: ArenaBuildTimingStage,
    spanName: string,
    attributes: Record<string, string | number | boolean>,
    operation: () => T,
  ): T => {
    const startedAt = performance.now();
    try {
      return withServerSpanSync(spanName, attributes, () => operation());
    } finally {
      recordStage(stage, performance.now() - startedAt);
    }
  };
  const measureStage = async <T,>(
    stage: ArenaBuildTimingStage,
    spanName: string,
    attributes: Record<string, string | number | boolean>,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await withServerSpan(spanName, attributes, () => operation());
    } finally {
      recordStage(stage, performance.now() - startedAt);
    }
  };
  const finishResponse = (
    response: Response,
    updates?: Partial<ArenaBuildDeliveryObservation>,
  ): Response => {
    observation = { ...observation, ...updates };
    if (observation.responseBytes == null) {
      const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(contentLength) && contentLength >= 0) {
        observation.responseBytes = contentLength;
      }
    }
    recordStage("body_ready", performance.now() - requestStartedAt);
    recordStage("total", performance.now() - requestStartedAt);
    timing.apply(response.headers);
    setActiveServerSpanAttributes({
      "arena.access": observation.access,
      "arena.variant": observation.variant,
      "arena.requested_format": observation.requestedFormat,
      "arena.served_format": observation.servedFormat,
      "arena.delivery_class": observation.deliveryClass,
      "arena.source": observation.source,
      "arena.artifact_outcome": observation.artifactOutcome,
      "arena.artifact_cache": observation.artifactCacheStatus,
      "arena.optimized_expected": observation.optimizedExpected,
      "arena.optimized_delivered": observation.optimizedDelivered,
      "arena.block_count_bucket": getArenaBlockCountBucket(observation.blockCount),
      ...(observation.fallbackReason
        ? { "arena.fallback_reason": observation.fallbackReason }
        : {}),
    });
    logArenaBuildDelivery(observation, stages, response.status);
    return response;
  };

  const { buildId: requestedBuildId } = await params;
  observation.access = requestedBuildId.startsWith("b1.") ? "blind" : "public";
  const buildAccess = measureStageSync(
    "token_validate",
    "arena.token.validate",
    {
      "arena.access": observation.access,
      "arena.variant": variant,
      "arena.requested_format": observation.requestedFormat,
    },
    () => parseArenaBuildAccessToken(requestedBuildId),
  );
  if (requestedBuildId.startsWith("b1.") && !buildAccess) {
    return finishResponse(NextResponse.json({ error: "Build not found" }, { status: 404 }), {
      source: "rejected",
      artifactOutcome: "invalid-token",
      servedFormat: "json",
    });
  }
  const buildId = buildAccess?.buildId ?? requestedBuildId;
  const clientBuildId = buildAccess ? requestedBuildId : buildId;
  const privateLoopbackAccess = Boolean(
    buildAccess &&
      isLoopbackDatabaseUrl(process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? ""),
  );
  const requestedChecksum = url.searchParams.get("checksum")?.trim() || null;
  if (buildAccess && requestedChecksum && requestedChecksum !== buildAccess.checksum) {
    return finishResponse(
      NextResponse.json({ error: "Build checksum mismatch" }, { status: 409 }),
      {
        source: "rejected",
        artifactOutcome: "checksum-mismatch",
        servedFormat: "json",
      },
    );
  }
  const expectedChecksum = buildAccess?.checksum ?? requestedChecksum;
  // pass the client-supplied checksum so the meta cache can detect stale
  // entries left behind by an overwrite import that landed on another lambda
  const buildMeta = await measureStage(
    "artifact_resolve",
    "arena.artifact.resolve",
    {
      "arena.access": observation.access,
      "arena.variant": variant,
      "arena.requested_format": observation.requestedFormat,
    },
    () => getArenaBuildMeta(buildId, expectedChecksum),
  );

  if (!buildMeta) {
    return finishResponse(NextResponse.json({ error: "Build not found" }, { status: 404 }), {
      source: "metadata-miss",
      artifactOutcome: "not-found",
      servedFormat: "json",
    });
  }
  if (buildMeta.privateAccessOnly && !buildAccess) {
    return finishResponse(NextResponse.json({ error: "Build not found" }, { status: 404 }), {
      source: "rejected",
      artifactOutcome: "private",
      servedFormat: "json",
    });
  }

  const storedChecksum = buildMeta.voxelSha256?.trim() || null;
  const artifactAllowed =
    !privateLoopbackAccess &&
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
  observation.deliveryClass = deliveryClass;
  observation.blockCount =
    variant === "preview" ? shellHints.previewBlockCount : shellHints.fullBlockCount;
  const binaryArtifactRequested =
    binaryFormatRequested && isBinarySnapshotArtifactEnabled();
  const fullUsesStreamDelivery =
    variant === "full" &&
    (shellHints.deliveryClass === "stream-live" ||
      shellHints.deliveryClass === "stream-artifact");
  const canServeSnapshotArtifact =
    url.searchParams.get("artifact") !== "0" &&
    Boolean(storedChecksum) &&
    ((variant === "preview" && SNAPSHOT_PREVIEW_ARTIFACT_REDIRECT_ENABLED) ||
      (variant === "full" &&
        (binaryArtifactRequested ||
          shellHints.deliveryClass === "snapshot" ||
          shellHints.deliveryClass === "inline")));
  // A v4 request for a stream-class full build must never fall through to a
  // cached or freshly prepared whole-body JSON response.
  const avoidWholeBodyJsonFallback = binaryFormatRequested && fullUsesStreamDelivery;
  let shouldRequireStreamFallbackOnSnapshotMiss = avoidWholeBodyJsonFallback;
  if (expectedChecksum && storedChecksum && expectedChecksum !== storedChecksum) {
    return finishResponse(
      NextResponse.json(
        buildAccess
          ? { error: "Build changed" }
          : {
              error: "Build checksum mismatch",
              expectedChecksum,
              actualChecksum: storedChecksum,
            },
        { status: 409 },
      ),
      {
        source: "rejected",
        artifactOutcome: "checksum-mismatch",
        servedFormat: "json",
      },
    );
  }

  // the client opts in per request, so a rollback is a client deploy and never
  // strands a reader on a format the server stopped writing
  // The binary object is additive, so a build without one yet must still be
  // served from the JSON object rather than counting as a snapshot miss and
  // pushing the client onto a stream fallback it does not need.
  const artifactFormats: ArenaSnapshotArtifactFormat[] =
    binaryArtifactRequested
      ? fullUsesStreamDelivery
        ? ["binary"]
        : ["binary", "json"]
      : ["json"];
  let servedArtifactFormat: ArenaSnapshotArtifactFormat = "json";

  if (
    !buildAccess &&
    SNAPSHOT_ARTIFACT_REDIRECT_ENABLED &&
    url.searchParams.get("redirect") !== "0" &&
    canServeSnapshotArtifact
  ) {
    // redirect first so node does not proxy large immutable snapshots
    const requireStreamFallbackOnMiss = variant === "full";
    try {
      let signedUrl: string | null = null;
      for (const format of artifactFormats) {
        try {
          signedUrl = await withServerSpan(
            "arena.artifact.sign",
            {
              "arena.access": observation.access,
              "arena.variant": variant,
              "arena.format": format,
            },
            () =>
              withTimeout(
                (signal) =>
                  createArenaBuildSnapshotArtifactSignedUrl(buildId, variant, storedChecksum, {
                    signal,
                    expiresInSec: SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC,
                    format,
                  }),
                SNAPSHOT_ARTIFACT_SIGN_TIMEOUT_MS,
                "snapshot artifact sign",
              ),
          );
        } catch (error) {
          if (format === "json") throw error;
          observation.fallbackReason = "binary-sign-error";
          console.warn("arena binary snapshot artifact sign failed; falling back", error);
          continue;
        }
        if (signedUrl) {
          servedArtifactFormat = format;
          break;
        }
      }
      if (signedUrl) {
        const headers = new Headers({
          "Cache-Control": createSignedRedirectCacheControl(SNAPSHOT_ARTIFACT_SIGN_URL_TTL_SEC),
          Location: signedUrl,
          "x-build-delivery-class": deliveryClass,
          "x-build-source": "artifact-redirect",
        });
        return finishResponse(new Response(null, { status: 307, headers }), {
          source: "artifact-redirect",
          artifactOutcome: "redirect",
          servedFormat: servedArtifactFormat === "binary" ? "binary" : "json",
          optimizedDelivered: servedArtifactFormat === "binary",
        });
      }
    } catch {
      // snapshot miss can still use the db snapshot
      observation.fallbackReason ??= "artifact-sign-error";
    }
    if (requireStreamFallbackOnMiss) {
      observation.artifactOutcome = "redirect-miss";
      shouldRequireStreamFallbackOnSnapshotMiss = true;
    }
  }

  const jsonCacheKey = buildAccess
    ? null
    : buildJsonResponseCacheKey(
        buildId,
        variant,
        storedChecksum,
        shellHints,
        shouldGzip,
      );
  // storage-first: the checksum-addressed artifact is the canonical snapshot
  let artifactFetchStartedAt: number | null = null;
  try {
    if (artifactAllowed && canServeSnapshotArtifact) {
      artifactFetchStartedAt = performance.now();
      let artifactBytes: Uint8Array | null = null;
      for (const format of artifactFormats) {
        const fetchMetrics: ArenaSnapshotArtifactFetchMetrics = { cacheStatus: "miss" };
        try {
          artifactBytes = await withServerSpan(
            "arena.artifact.fetch",
            {
              "arena.access": observation.access,
              "arena.variant": variant,
              "arena.format": format,
            },
            async (span) => {
              const bytes = await withTimeout(
                (signal) =>
                  fetchArenaBuildSnapshotArtifact(buildId, variant, storedChecksum, {
                    signal,
                    format,
                    cache: buildAccess ? "no-store" : "default",
                    metrics: fetchMetrics,
                  }),
                SNAPSHOT_ARTIFACT_FETCH_TIMEOUT_MS,
                "snapshot artifact fetch",
              );
              span.setAttributes({
                "arena.artifact_cache": fetchMetrics.cacheStatus,
                "arena.artifact_hit": Boolean(bytes),
                ...(fetchMetrics.transferBytes != null
                  ? { "arena.transfer_bytes": fetchMetrics.transferBytes }
                  : {}),
                ...(fetchMetrics.decodedBytes != null
                  ? { "arena.decoded_bytes": fetchMetrics.decodedBytes }
                  : {}),
              });
              return bytes;
            },
          );
        } catch (error) {
          if (format === "json") throw error;
          observation.fallbackReason = "binary-artifact-error";
          console.warn("arena binary snapshot artifact fetch failed; falling back", error);
          continue;
        } finally {
          observation.artifactCacheStatus = fetchMetrics.cacheStatus;
          observation.transferBytes = fetchMetrics.transferBytes ?? observation.transferBytes;
          observation.decodedBytes = fetchMetrics.decodedBytes ?? observation.decodedBytes;
          if (fetchMetrics.inflateMs != null) {
            recordStage("inflate", fetchMetrics.inflateMs);
          }
        }
        if (artifactBytes) {
          servedArtifactFormat = format;
          break;
        }
      }
      const artifactFetchMs = performance.now() - artifactFetchStartedAt;
      recordStage("artifact_fetch", artifactFetchMs);
      artifactFetchStartedAt = null;
      if (artifactBytes) {
        timing.add("artifact_hit", artifactFetchMs);
        observation.artifactOutcome = "hit";
        const responseArtifactBytes = buildAccess
          ? measureStageSync(
              "identity_rewrite",
              "arena.artifact.identity_rewrite",
              {
                "arena.variant": variant,
                "arena.format": servedArtifactFormat,
              },
              () =>
                servedArtifactFormat === "binary"
                  ? rewriteBlindBinaryArtifactIdentity(artifactBytes, clientBuildId)
                  : rewriteBlindSnapshotIdentity(artifactBytes, clientBuildId),
            )
          : artifactBytes;
        // the stored object is gzip; proxying it verbatim to a gzip-capable
        // client keeps snapshot-class fallbacks off the uncompressed path
        const body = shouldGzip
          ? measureStageSync(
              "deflate",
              "arena.response.deflate",
              {
                "arena.variant": variant,
                "arena.format": servedArtifactFormat,
              },
              () => gzipSync(Buffer.from(responseArtifactBytes)),
            )
          : responseArtifactBytes;
        const headers = new Headers({
          "Cache-Control": buildAccess
            ? "private, no-store"
            : "public, max-age=0, s-maxage=300, stale-while-revalidate=86400, no-transform",
          "Content-Type":
            servedArtifactFormat === "binary"
              ? "application/octet-stream"
              : "application/json; charset=utf-8",
          "Content-Length": String(body.byteLength),
          "x-build-delivery-class": deliveryClass,
          "x-build-source": "artifact",
        });
        if (shouldGzip) {
          headers.set("Content-Encoding", "gzip");
          headers.set("Vary", "Accept-Encoding");
        }
        return finishResponse(new Response(Buffer.from(body), { headers }), {
          source: "artifact",
          servedFormat: servedArtifactFormat === "binary" ? "binary" : "json",
          optimizedDelivered: servedArtifactFormat === "binary",
          fallbackReason:
            binaryFormatRequested && servedArtifactFormat !== "binary"
              ? observation.fallbackReason ?? "binary-artifact-miss"
              : observation.fallbackReason,
          responseBytes: body.byteLength,
        });
      }
      observation.artifactOutcome = "miss";
      timing.add("artifact_miss", artifactFetchMs);
    }
  } catch (error) {
    if (artifactFetchStartedAt != null) {
      recordStage("artifact_fetch", performance.now() - artifactFetchStartedAt);
      artifactFetchStartedAt = null;
    }
    observation.artifactOutcome = "error";
    observation.fallbackReason ??= "artifact-fetch-error";
    console.warn("arena snapshot artifact fetch failed", error);
  }

  const cachedJsonResponse =
    !buildAccess && !avoidWholeBodyJsonFallback && jsonCacheKey
      ? getCachedJsonResponseByKey(jsonCacheKey)
      : null;
  // This body exists because the artifact was missing when it was built, so
  // returning it short-circuits the heal in the after() hook below. Re-arm from
  // the prepared cache when possible; the success set makes that a no-op once
  // the artifact exists. The two caches are sized independently, so when the
  // prepared entry has been evicted the response entry is dropped instead and
  // the request falls through to preparation, which heals. Otherwise a stale
  // body could be served indefinitely with the snapshot still absent.
  const cachedPreparedForHeal = cachedJsonResponse
    ? !buildMeta.privateAccessOnly
      ? getCachedPreparedArenaBuild(buildId, storedChecksum)
      : null
    : null;
  if (cachedJsonResponse && !cachedPreparedForHeal && jsonCacheKey) {
    dropCachedJsonResponse(jsonCacheKey);
  }
  if (cachedJsonResponse && cachedPreparedForHeal) {
    after(async () => {
      await healArenaBuildSnapshotArtifactsOnce(cachedPreparedForHeal);
    });
    const headers = createJsonHeaders({
      byteLength: cachedJsonResponse.bytes.byteLength,
      deliveryClass: variant === "preview" ? shellHints.initialDeliveryClass : shellHints.deliveryClass,
      source: `response-cache:${cachedJsonResponse.source}`,
      gzip: shouldGzip,
    });
    return finishResponse(new Response(Buffer.from(cachedJsonResponse.bytes), { headers }), {
      source: `response-cache:${cachedJsonResponse.source}`,
      artifactOutcome:
        observation.artifactOutcome === "not-attempted"
          ? "response-cache"
          : observation.artifactOutcome,
      servedFormat: "json",
      optimizedDelivered: false,
      fallbackReason: binaryFormatRequested
        ? observation.fallbackReason ?? "binary-artifact-unavailable"
        : observation.fallbackReason,
      responseBytes: cachedJsonResponse.bytes.byteLength,
    });
  }

  if (shouldRequireStreamFallbackOnSnapshotMiss) {
    // full snapshot misses should switch to stream, not rebuild inline
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Retry-After": "1",
      "x-build-delivery-class": deliveryClass,
      "x-build-source": "artifact-redirect-miss",
    });
    return finishResponse(
      NextResponse.json(
        {
          error: "Full build artifact is still warming. Use stream fallback.",
          retryVia: "stream",
        },
        { status: 503, headers },
      ),
      {
        source: "artifact-redirect-miss",
        artifactOutcome:
          observation.artifactOutcome === "not-attempted"
            ? "redirect-miss"
            : observation.artifactOutcome,
        servedFormat: "json",
        fallbackReason: observation.fallbackReason ?? "stream-fallback-required",
      },
    );
  }

  if (variant === "full" && shellHints.deliveryClass === "stream-artifact") {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Retry-After": "1",
      "x-build-delivery-class": shellHints.deliveryClass,
      "x-build-source": "stream-required",
    });
    return finishResponse(
      NextResponse.json(
        {
          error: "Build must be loaded through the stream artifact endpoint.",
          retryVia: "stream",
        },
        { status: 503, headers },
      ),
      {
        source: "stream-required",
        artifactOutcome: "not-eligible",
        servedFormat: "json",
        fallbackReason: "stream-required",
      },
    );
  }

  let prepared = buildMeta.privateAccessOnly
    ? null
    : getCachedPreparedArenaBuild(buildId, storedChecksum);
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
        return finishResponse(NextResponse.json({ error: "Build not found" }, { status: 404 }), {
          source: "live-prepare",
          artifactOutcome: "not-found",
          servedFormat: "json",
        });
      }
      prepared = await withServerSpan(
        "arena.build.prepare",
        {
          "arena.access": observation.access,
          "arena.variant": variant,
          "arena.delivery_class": deliveryClass,
        },
        () =>
          prepareArenaBuild(
            { ...build, privateAccessOnly: buildMeta.privateAccessOnly },
            { signal: request.signal },
          ),
      );
    } catch (err) {
      const message =
        !buildAccess && err instanceof Error ? err.message : "Failed to load build payload";
      return finishResponse(NextResponse.json({ error: message }, { status: 422 }), {
        source: "live-prepare",
        artifactOutcome: "prepare-error",
        servedFormat: "json",
        fallbackReason: observation.fallbackReason ?? "live-prepare-error",
      });
    }
    timing.end("prepare", prepareStartedAt);
  }

  if (expectedChecksum && expectedChecksum !== prepared.checksum) {
    return finishResponse(
      NextResponse.json(
        buildAccess
          ? { error: "Build changed" }
          : {
              error: "Build checksum mismatch",
              expectedChecksum,
              actualChecksum: prepared.checksum,
            },
        { status: 409 },
      ),
      {
        source: "live-prepare",
        artifactOutcome: "checksum-mismatch",
        servedFormat: "json",
      },
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
    // dedupes on success and retries after a failure, so warm cache hits do not
    // re-upload and a transient failure is not permanent
    if (!privateLoopbackAccess) await healArenaBuildSnapshotArtifactsOnce(prepared);
  });

  const createResponseBytes = () =>
    jsonBytes(
      {
        buildId: clientBuildId,
        variant,
        checksum: buildAccess ? null : prepared.checksum,
        serverValidated: true,
        buildLoadHints: prepared.hints,
        voxelBuild,
      },
      shouldGzip,
    );
  const responseBytes = shouldGzip
    ? measureStageSync(
        "deflate",
        "arena.response.deflate",
        {
          "arena.variant": variant,
          "arena.format": "json",
        },
        createResponseBytes,
      )
    : createResponseBytes();
  if (!buildAccess) {
    rememberJsonResponse(
      prepared.buildId,
      variant,
      prepared.checksum,
      prepared.hints,
      shouldGzip,
      responseBytes,
      "live",
    );
  }
  const headers = createJsonHeaders({
    byteLength: responseBytes.byteLength,
    deliveryClass: variant === "preview" ? prepared.hints.initialDeliveryClass : prepared.hints.deliveryClass,
    source: "live",
    gzip: shouldGzip,
    privateAccess: Boolean(buildAccess),
  });
  return finishResponse(new Response(Buffer.from(responseBytes), { headers }), {
    source: "live",
    artifactOutcome:
      observation.artifactOutcome === "not-attempted" ? "live" : observation.artifactOutcome,
    servedFormat: "json",
    optimizedDelivered: false,
    fallbackReason: binaryFormatRequested
      ? observation.fallbackReason ?? "binary-artifact-unavailable"
      : observation.fallbackReason,
    responseBytes: responseBytes.byteLength,
  });
}
