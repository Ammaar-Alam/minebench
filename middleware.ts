import { NextRequest, NextResponse } from "next/server";
import { LEGACY_HOSTS, SITE_HOST } from "@/lib/seo";

const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 18;
const MAX_PER_WINDOW_LOCAL_EXEC = 6;
const RATE_LIMIT_SESSION_COOKIE = "mb_rls";
const ARENA_IP_GUARDRAIL_MULTIPLIER = 12;
const BUCKET_PRUNE_INTERVAL = 256;

type Bucket = { resetAt: number; count: number };
const buckets = new Map<string, Bucket>();
type RateLimitRule = { key: string; maxPerWindow: number };
let requestsSinceLastPrune = 0;

function getIp(req: NextRequest) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return "unknown";
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

function consumeBucket(key: string, maxPerWindow: number, now: number) {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { resetAt: now + WINDOW_MS, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > maxPerWindow) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

function consumeBuckets(rules: RateLimitRule[], now: number) {
  for (const rule of rules) {
    const result = consumeBucket(rule.key, rule.maxPerWindow, now);
    if (!result.allowed) {
      return result;
    }
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

function getArenaRateLimitSession(req: NextRequest) {
  const existing = req.cookies.get(RATE_LIMIT_SESSION_COOKIE)?.value?.trim();
  if (existing) return { sessionId: existing, shouldSetCookie: false };
  return { sessionId: crypto.randomUUID(), shouldSetCookie: true };
}

export function middleware(req: NextRequest) {
  const canonicalRedirect = maybeRedirectToCanonicalHost(req);
  if (canonicalRedirect) return canonicalRedirect;

  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (pathname.startsWith("/api/admin/")) return NextResponse.next();
  const isArenaApi = pathname.startsWith("/api/arena/");
  const maxPerWindow = pathname === "/api/local/voxel-exec" ? MAX_PER_WINDOW_LOCAL_EXEC : MAX_PER_WINDOW;
  const bucketPath = normalizeRateLimitPath(pathname);
  const ip = getIp(req);
  const now = Date.now();
  maybePruneExpiredBuckets(now);
  const arenaSession = isArenaApi ? getArenaRateLimitSession(req) : null;
  const rules: RateLimitRule[] = isArenaApi
    ? [
        // Keep arena primarily session-scoped, but retain a wider IP guardrail so
        // clients cannot disable throttling by dropping or rotating cookies.
        {
          key: `ip:${ip}:${bucketPath}`,
          maxPerWindow: maxPerWindow * ARENA_IP_GUARDRAIL_MULTIPLIER,
        },
        { key: `session:${arenaSession?.sessionId}:${bucketPath}`, maxPerWindow },
      ]
    : [{ key: `${ip}:${bucketPath}`, maxPerWindow }];

  const rateLimit = consumeBuckets(rules, now);
  if (!rateLimit.allowed) {
    return rateLimitedResponse(rateLimit.retryAfterSeconds);
  }

  const response = NextResponse.next();
  if (arenaSession?.shouldSetCookie) {
    response.cookies.set(RATE_LIMIT_SESSION_COOKIE, arenaSession.sessionId, {
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
