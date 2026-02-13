import { NextRequest, NextResponse } from "next/server";
import { LEGACY_HOSTS, SITE_HOST } from "@/lib/seo";

const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 18;

type Bucket = { resetAt: number; count: number };
const buckets = new Map<string, Bucket>();

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

export function middleware(req: NextRequest) {
  const canonicalRedirect = maybeRedirectToCanonicalHost(req);
  if (canonicalRedirect) return canonicalRedirect;

  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (pathname.startsWith("/api/admin/")) return NextResponse.next();

  const ip = getIp(req);
  const key = `${ip}:${pathname}`;
  const now = Date.now();

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { resetAt: now + WINDOW_MS, count: 1 });
    return NextResponse.next();
  }

  bucket.count += 1;
  if (bucket.count > MAX_PER_WINDOW) {
    return new NextResponse("Too Many Requests", {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil((bucket.resetAt - now) / 1000)),
      },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
