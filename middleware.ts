import { NextRequest, NextResponse } from "next/server";
import { LEGACY_HOSTS, SITE_HOST } from "@/lib/seo";

const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 18;
const MAX_PER_WINDOW_LOCAL_EXEC = 6;
const RATE_LIMIT_SESSION_COOKIE = "mb_rls";
const ARENA_IP_GUARDRAIL_MULTIPLIER = readIntEnv("ARENA_IP_GUARDRAIL_MULTIPLIER", 250, 1, 1000);
const ARENA_BUILD_IP_GUARDRAIL_MULTIPLIER = readIntEnv(
  "ARENA_BUILD_IP_GUARDRAIL_MULTIPLIER",
  1000,
  1,
  5000,
);
const BUCKET_PRUNE_INTERVAL = 256;

type Bucket = { resetAt: number; count: number };
const buckets = new Map<string, Bucket>();
type RateLimitRule = { key: string; maxPerWindow: number };
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

function getIp(req: NextRequest): string | null {
  const requestIp = (req as NextRequest & { ip?: string | null }).ip?.trim();
  if (requestIp) return requestIp;

  const trustForwardedFor = readBoolEnv("ARENA_TRUST_X_FORWARDED_FOR", process.env.VERCEL === "1");
  if (!trustForwardedFor) return null;

  const direct =
    req.headers.get("x-real-ip") ??
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-vercel-forwarded-for");
  if (direct) return direct.split(",")[0]?.trim() || null;

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || null;
  return null;
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

function normalizeRateLimitPath(pathname: string): string {
  if (/^\/api\/arena\/builds\/[^/]+\/stream$/.test(pathname)) {
    return "/api/arena/builds/:buildId/stream";
  }
  if (/^\/api\/arena\/builds\/[^/]+$/.test(pathname)) {
    return "/api/arena/builds/:buildId";
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
    const resetAt = !bucket || bucket.resetAt <= now ? now + WINDOW_MS : bucket.resetAt;
    const nextCount = !bucket || bucket.resetAt <= now ? 1 : bucket.count + 1;

    if (nextCount > rule.maxPerWindow) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((resetAt - now) / 1000),
      };
    }

    previews.push({ key: rule.key, resetAt, nextCount });
  }

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

function getArenaRateLimitSession(req: NextRequest, stableFallbackBucketId: string | null) {
  const existing = req.cookies.get(RATE_LIMIT_SESSION_COOKIE)?.value?.trim();
  if (existing) return { bucketId: existing, cookieValue: null };
  const id = crypto.randomUUID();
  return {
    bucketId: stableFallbackBucketId ?? id,
    cookieValue: id,
  };
}

export function middleware(req: NextRequest) {
  const canonicalRedirect = maybeRedirectToCanonicalHost(req);
  if (canonicalRedirect) return canonicalRedirect;

  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (pathname.startsWith("/api/admin/")) return NextResponse.next();
  const isArenaApi = pathname.startsWith("/api/arena/");
  const isArenaBuildAsset = /^\/api\/arena\/builds\/[^/]+(?:\/stream)?$/.test(pathname);
  const maxPerWindow = pathname === "/api/local/voxel-exec" ? MAX_PER_WINDOW_LOCAL_EXEC : MAX_PER_WINDOW;
  const bucketPath = normalizeRateLimitPath(pathname);
  const ip = getIp(req);
  const ipBucket = ip ?? "unknown";
  const now = Date.now();
  maybePruneExpiredBuckets(now);
  const arenaSession = isArenaApi
    ? getArenaRateLimitSession(req, ip ? `anon:${ip}` : null)
    : null;
  const arenaIpRules = ip
    ? [
        // wide ip guardrail when a trusted ip exists
        {
          key: `ip:${ip}:${bucketPath}`,
          maxPerWindow: maxPerWindow * ARENA_IP_GUARDRAIL_MULTIPLIER,
        },
      ]
    : [];
  const rules: RateLimitRule[] = isArenaApi
    ? isArenaBuildAsset
      ? ip
        ? [
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
          { key: `session:${arenaSession?.bucketId}:${bucketPath}`, maxPerWindow },
        ]
    : [{ key: `${ipBucket}:${bucketPath}`, maxPerWindow }];

  const rateLimit = consumeBuckets(rules, now);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit.retryAfterSeconds);
  }

  const response = NextResponse.next();
  if (arenaSession?.cookieValue) {
    response.cookies.set(RATE_LIMIT_SESSION_COOKIE, arenaSession.cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
