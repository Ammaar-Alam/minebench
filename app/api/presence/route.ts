import { geolocation } from "@vercel/functions";
import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth/request";
import {
  ARENA_SESSION_COOKIE,
  ARENA_SESSION_COOKIE_OPTIONS,
  readArenaSessionId,
} from "@/lib/arena/session";
import { touchPublicSessionActivity } from "@/lib/publicPresence";
import { hashVoteIp, trustedClientIp } from "@/lib/voteBlock";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const existing = readArenaSessionId(request.headers.get("cookie"));
  const sessionId = existing && existing.length <= 128 ? existing : crypto.randomUUID();
  try {
    const geo = geolocation(request);
    await touchPublicSessionActivity({
      sessionId,
      userId: await getAuthenticatedUserId(request),
      ipHmac: hashVoteIp(trustedClientIp(request.headers)),
      location: {
        city: geo.city,
        countryRegion: geo.countryRegion,
        country: geo.country,
      },
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    console.warn("Public presence update failed", { code });
  }

  const response = new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "private, no-store" },
  });
  if (!existing || existing !== sessionId) {
    response.cookies.set(ARENA_SESSION_COOKIE, sessionId, ARENA_SESSION_COOKIE_OPTIONS);
  }
  return response;
}
