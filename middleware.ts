import { NextRequest, NextResponse } from "next/server";
import { LEGACY_HOSTS, SITE_HOST } from "@/lib/seo";
import { resolveModelSlug } from "@/lib/ai/modelCatalog";
import { hasSupabaseAuthCookie } from "@/lib/auth/cookies";

const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 18;
const MAX_PER_WINDOW_LOCAL_EXEC = 6;
const CONTACT_WINDOW_MS = 60 * 60 * 1000;
const CONTACT_MAX_PER_SESSION = 3;
const CONTACT_MAX_PER_IP = 10;
const NO_IP_MODEL_GLOBAL_GUARDRAIL_MULTIPLIER = 10;
const CUSTOM_BUILD_WINDOW_MS = 10 * 60 * 1000;
const GALLERY_REPORT_WINDOW_MS = 60 * 60 * 1000;
const GALLERY_REPORT_MAX_PER_IP = 20;
const GALLERY_REPORT_MAX_PER_SESSION = 5;
const RATE_LIMIT_SESSION_COOKIE = "mb_rls";
const CUSTOM_BUILD_MAX_CREATE_PER_IP_10M = readIntEnv("CUSTOM_BUILD_MAX_CREATE_PER_IP_10M", 10, 1, 1000);
const CUSTOM_BUILD_MAX_CREATE_PER_SESSION_10M = readIntEnv("CUSTOM_BUILD_MAX_CREATE_PER_SESSION_10M", 5, 1, 1000);
const ARENA_IP_GUARDRAIL_MULTIPLIER = readIntEnv("ARENA_IP_GUARDRAIL_MULTIPLIER", 250, 1, 1000);
const ARENA_BUILD_IP_GUARDRAIL_MULTIPLIER = readIntEnv(
  "ARENA_BUILD_IP_GUARDRAIL_MULTIPLIER",
  1000,
  1,
  5000,
);
const ARENA_NEW_SESSION_IP_GUARDRAIL_MULTIPLIER = readIntEnv(
  "ARENA_NEW_SESSION_IP_GUARDRAIL_MULTIPLIER",
  10,
  1,
  100,
);
const BUCKET_PRUNE_INTERVAL = 256;

type Bucket = { resetAt: number; count: number };
const buckets = new Map<string, Bucket>();
type RateLimitRule = { key: string; maxPerWindow: number; windowMs?: number };
type IpInfo = { value: string | null; trusted: boolean };
let requestsSinceLastPrune = 0;
type BucketPreview = { key: string; resetAt: number; nextCount: number };

function readIntEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function readBoolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getIp(req: NextRequest): IpInfo {
  const requestIp = (req as NextRequest & { ip?: string | null }).ip?.trim();
  if (requestIp) return { value: requestIp, trusted: true };

  const trustForwardedRaw = process.env.ARENA_TRUST_X_FORWARDED_FOR;
  const trustForwardedFor = readBoolEnv("ARENA_TRUST_X_FORWARDED_FOR", process.env.VERCEL === "1");
  if (trustForwardedFor) {
    const direct =
      req.headers.get("x-real-ip") ??
      req.headers.get("cf-connecting-ip") ??
      req.headers.get("x-vercel-forwarded-for");
    if (direct) return { value: direct.split(",")[0]?.trim() || null, trusted: true };
  }

  const forwarded = req.headers.get("x-forwarded-for");
  const allowForwardedFallback =
    trustForwardedFor || (!trustForwardedRaw && readBoolEnv("ARENA_FORWARDED_IP_FALLBACK", true));
  // fallback for non vercel reverse proxies without next ip
  if (allowForwardedFallback && forwarded) {
    return {
      value: forwarded.split(",")[0]?.trim() || null,
      trusted: trustForwardedFor,
    };
  }
  return { value: null, trusted: false };
}

function maybeRedirectToCanonicalHost(req: NextRequest) {
  if (process.env.NODE_ENV !== "production") return null;
  const hostHeader = req.headers.get("host");
  if (!hostHeader) return null;

  const host = hostHeader.split(":")[0]?.toLowerCase();
  if (!host || !LEGACY_HOSTS.has(host)) return null;

  const nextUrl = req.nextUrl.clone();
  nextUrl.protocol = "https";
  nextUrl.host = SITE_HOST;
  return NextResponse.redirect(nextUrl, 308);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function maybeRedirectToCanonicalModelSlug(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const match = pathname.match(/^\/leaderboard\/([^/]+)$/);
  if (!match) return null;

  const rawKey = safeDecodeURIComponent(match[1]);
  if (!rawKey) return null;

  const canonicalSlug = resolveModelSlug(rawKey);
  if (canonicalSlug && canonicalSlug !== rawKey) {
    const nextUrl = req.nextUrl.clone();
    nextUrl.pathname = `/leaderboard/${encodeURIComponent(canonicalSlug)}`;
    return NextResponse.redirect(nextUrl, 308);
  }
  return null;
}

function isModelDetailPath(pathname: string): boolean {
  return /^\/api\/leaderboard\/models\/[^/]+$/.test(pathname);
}

function normalizeRateLimitPath(pathname: string): string {
  if (/^\/api\/lab\/organizations\/[^/]+\/builds\/[^/]+$/.test(pathname)) {
    return "/api/lab/organizations/:orgSlug/builds/:resultId";
  }
  if (
    /^\/api\/lab\/organizations\/[^/]+\/experiments\/[^/]+\/(?:cohort-upload|export)$/.test(
      pathname,
    )
  ) {
    return pathname.endsWith("/export")
      ? "/api/lab/organizations/:orgSlug/experiments/:experimentId/export"
      : "/api/lab/organizations/:orgSlug/experiments/:experimentId/cohort-upload";
  }
  if (/^\/api\/arena\/builds\/[^/]+\/stream$/.test(pathname)) {
    return "/api/arena/builds/:buildId/stream";
  }
  if (/^\/api\/arena\/builds\/[^/]+$/.test(pathname)) {
    return "/api/arena/builds/:buildId";
  }
  if (isModelDetailPath(pathname)) {
    return "/api/leaderboard/models/:modelKey";
  }
  return pathname;
}

function maybePruneExpiredBuckets(now: number) {
  requestsSinceLastPrune += 1;
  if (requestsSinceLastPrune < BUCKET_PRUNE_INTERVAL) return;
  requestsSinceLastPrune = 0;

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function consumeBuckets(rules: RateLimitRule[], now: number) {
  const previews: BucketPreview[] = [];

  for (const rule of rules) {
    const bucket = buckets.get(rule.key);
    const windowMs = rule.windowMs ?? WINDOW_MS;
    const resetAt = !bucket || bucket.resetAt <= now ? now + windowMs : bucket.resetAt;
    const nextCount = !bucket || bucket.resetAt <= now ? 1 : bucket.count + 1;

    if (nextCount > rule.maxPerWindow) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((resetAt - now) / 1000),
      };
    }

    previews.push({ key: rule.key, resetAt, nextCount });
  }

  // commit all buckets together so partial limits cannot leak counts
  for (const preview of previews) {
    buckets.set(preview.key, { resetAt: preview.resetAt, count: preview.nextCount });
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
  };
}

function rateLimitedResponse(retryAfterSeconds: number) {
  return new NextResponse("Too Many Requests", {
    status: 429,
    headers: {
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getHeaderFingerprint(req: NextRequest): string {
  const parts = [
    req.headers.get("user-agent"),
    req.headers.get("accept-language"),
    req.headers.get("sec-ch-ua"),
    req.headers.get("sec-ch-ua-platform"),
    req.headers.get("sec-ch-ua-mobile"),
    req.headers.get("accept"),
  ]
    .map((value) => value?.trim().slice(0, 256) ?? "")
    .filter(Boolean);
  return parts.join("|") || "unknown";
}

function getAnonymousBucketId(req: NextRequest, ip: string | null): string {
  // stable fallback for clients that block cookies
  return `anon:${stableHash(`${ip ?? "no-ip"}|${getHeaderFingerprint(req)}`)}`;
}

function getRateLimitSession(req: NextRequest, fallbackBucketId: string) {
  const existing = req.cookies.get(RATE_LIMIT_SESSION_COOKIE)?.value?.trim();
  if (existing) return { bucketId: existing, cookieValue: null, isNew: false };
  const id = crypto.randomUUID();
  return {
    // fallback catches clients that drop the cookie
    bucketId: fallbackBucketId,
    cookieValue: id,
    isNew: true,
  };
}

export async function middleware(req: NextRequest) {
  const canonicalRedirect = maybeRedirectToCanonicalHost(req);
  if (canonicalRedirect) return canonicalRedirect;

  const modelSlugRedirect = maybeRedirectToCanonicalModelSlug(req);
  if (modelSlugRedirect) return modelSlugRedirect;

  const { pathname } = req.nextUrl;
  const isLabApi = pathname.startsWith("/api/lab/");
  const isGalleryAccountApi = hasSupabaseAuthCookie(req.headers.get("cookie")) && (
    pathname.startsWith("/api/generations") || pathname.startsWith("/api/gallery")
  );
  const refreshesSupabase =
    pathname.startsWith("/lab") ||
    isLabApi ||
    pathname === "/sandbox" ||
    pathname.startsWith("/gallery") ||
    pathname.startsWith("/admin/gallery") ||
    pathname.startsWith("/admin/private-evaluations") ||
    isGalleryAccountApi ||
    pathname === "/account" ||
    pathname === "/sign-in" ||
    pathname === "/sign-up" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    pathname.startsWith("/auth/");
  if (refreshesSupabase && !pathname.startsWith("/api/")) {
    const { refreshSupabaseSession } = await import("@/lib/supabase/middleware");
    return refreshSupabaseSession(req);
  }
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (pathname.startsWith("/api/admin/")) return NextResponse.next();
  const isContactApi = pathname === "/api/contact";
  const isArenaApi = pathname.startsWith("/api/arena/");
  const isModelDetailApi = isModelDetailPath(pathname);
  const isArenaBuildAsset = /^\/api\/arena\/builds\/[^/]+(?:\/stream)?$/.test(pathname);
  const isCustomBuildCreate =
    (pathname === "/api/custom-builds" || pathname === "/api/generations") && req.method === "POST";
  const isGalleryReport = pathname === "/api/gallery/reports" && req.method === "POST";
  const maxPerWindow = pathname === "/api/local/voxel-exec" ? MAX_PER_WINDOW_LOCAL_EXEC : MAX_PER_WINDOW;
  const { value: ip, trusted: hasTrustedIp } = getIp(req);
  const modelAnonymousBucketId = isModelDetailApi && !hasTrustedIp
    ? getAnonymousBucketId(req, null)
    : null;
  const modelSession = modelAnonymousBucketId
    ? getRateLimitSession(req, modelAnonymousBucketId)
    : null;
  const bucketPath = normalizeRateLimitPath(pathname);
  const ipBucket = ip ?? "unknown";
  const now = Date.now();
  maybePruneExpiredBuckets(now);
  const contactIp = hasTrustedIp ? ip : null;
  const contactSession = isContactApi
    ? getRateLimitSession(req, getAnonymousBucketId(req, contactIp))
    : null;
  const arenaSession = isArenaApi
    ? getRateLimitSession(req, getAnonymousBucketId(req, ip))
    : null;
  const customBuildSession = isCustomBuildCreate
    ? getRateLimitSession(req, getAnonymousBucketId(req, ip))
    : null;
  const galleryReportSession = isGalleryReport
    ? getRateLimitSession(req, getAnonymousBucketId(req, ip))
    : null;
  const arenaIpRules = ip
    ? [
        // wide client guardrail when an ip signal exists
        {
          key: `ip:${ip}:${bucketPath}`,
          maxPerWindow: maxPerWindow * ARENA_IP_GUARDRAIL_MULTIPLIER,
        },
      ]
    : [];
  const arenaNewSessionIpRules =
    arenaSession?.isNew && ip && !isArenaBuildAsset
      ? [
          // cookie-drop guardrail, looser than per-session
          {
            key: `anon:${ip}:${bucketPath}`,
            maxPerWindow: maxPerWindow * ARENA_NEW_SESSION_IP_GUARDRAIL_MULTIPLIER,
          },
        ]
      : [];
  const rules: RateLimitRule[] = isCustomBuildCreate
    ? [
        ...(ip
          ? [
              {
                key: `custom-build-ip:${ip}`,
                maxPerWindow: CUSTOM_BUILD_MAX_CREATE_PER_IP_10M,
                windowMs: CUSTOM_BUILD_WINDOW_MS,
              },
            ]
          : []),
        {
          key: `custom-build-session:${customBuildSession?.bucketId ?? ipBucket}`,
          maxPerWindow: CUSTOM_BUILD_MAX_CREATE_PER_SESSION_10M,
          windowMs: CUSTOM_BUILD_WINDOW_MS,
        },
      ]
    : isGalleryReport
    ? [
        ...(hasTrustedIp && ip
          ? [
              {
                key: `gallery-report-ip:${ip}`,
                maxPerWindow: GALLERY_REPORT_MAX_PER_IP,
                windowMs: GALLERY_REPORT_WINDOW_MS,
              },
            ]
          : []),
        {
          key: `gallery-report-session:${galleryReportSession?.bucketId ?? ipBucket}`,
          maxPerWindow: GALLERY_REPORT_MAX_PER_SESSION,
          windowMs: GALLERY_REPORT_WINDOW_MS,
        },
      ]
    : isContactApi
    ? [
        ...(contactIp
          ? [
              {
                key: `ip:${contactIp}:${bucketPath}`,
                maxPerWindow: CONTACT_MAX_PER_IP,
                windowMs: CONTACT_WINDOW_MS,
              },
            ]
          : []),
        {
          key: `session:${contactSession!.bucketId}:${bucketPath}`,
          maxPerWindow: CONTACT_MAX_PER_SESSION,
          windowMs: CONTACT_WINDOW_MS,
        },
      ]
    : isArenaApi
    ? isArenaBuildAsset
      ? ip
        ? [
            // build fetches are heavy but numerous during one arena page
            {
              key: `ip:${ip}:${bucketPath}`,
              maxPerWindow: maxPerWindow * ARENA_BUILD_IP_GUARDRAIL_MULTIPLIER,
            },
          ]
        : arenaSession
          ? [
            // no trusted ip, avoid one shared unknown bucket
            {
              key: `session:${arenaSession.bucketId}:${bucketPath}`,
              maxPerWindow: maxPerWindow * ARENA_BUILD_IP_GUARDRAIL_MULTIPLIER,
            },
          ]
          : []
      : [
          ...arenaIpRules,
          ...arenaNewSessionIpRules,
          { key: `session:${arenaSession?.bucketId}:${bucketPath}`, maxPerWindow },
        ]
    : [
        ...(modelAnonymousBucketId
          ? [
              {
                key: `anon:${modelAnonymousBucketId}:${bucketPath}`,
                maxPerWindow: MAX_PER_WINDOW * NO_IP_MODEL_GLOBAL_GUARDRAIL_MULTIPLIER,
              },
              {
                key: `global:no-ip:${bucketPath}`,
                maxPerWindow: MAX_PER_WINDOW * NO_IP_MODEL_GLOBAL_GUARDRAIL_MULTIPLIER,
              },
            ]
          : []),
        {
          key: `${modelSession ? `session:${modelSession.bucketId}` : ip ? `ip:${ip}` : `session:${ipBucket}`}:${bucketPath}`,
          maxPerWindow,
        },
      ];

  const rateLimit = consumeBuckets(rules, now);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit.retryAfterSeconds);
  }

  const response = isLabApi
    ? await (await import("@/lib/supabase/middleware")).refreshSupabaseSession(req)
    : isGalleryAccountApi
      ? await (await import("@/lib/supabase/middleware")).refreshSupabaseSession(req)
      : NextResponse.next();
  const rateLimitSession = arenaSession ?? modelSession ?? contactSession ?? customBuildSession ?? galleryReportSession;
  if (rateLimitSession?.cookieValue) {
    response.cookies.set(RATE_LIMIT_SESSION_COOKIE, rateLimitSession.cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/).*)"],
};
