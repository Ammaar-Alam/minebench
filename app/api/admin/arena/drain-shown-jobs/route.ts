import { NextResponse } from "next/server";
import { drainArenaShownJobs, getArenaShownJobStatus } from "@/lib/arena/shownJobs";
import { ServerTiming } from "@/lib/serverTiming";

export const runtime = "nodejs";

const DEFAULT_MAX_JOBS = 10_000;
const DEFAULT_MAX_MS = 50_000;

function requireAdmin(req: Request): string | null {
  const allowedTokens = [process.env.ADMIN_TOKEN, process.env.CRON_SECRET]
    .map((token) => token?.trim())
    .filter((token): token is string => Boolean(token));
  if (allowedTokens.length === 0) return "Missing ADMIN_TOKEN or CRON_SECRET on server";

  const auth = req.headers.get("authorization");
  if (!auth) return "Missing Authorization header (expected: Authorization: Bearer <token>)";

  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "Invalid Authorization header (expected: Authorization: Bearer <token>)";

  const presented = match[1]?.trim();
  if (!presented) return "Empty Bearer token";
  if (!allowedTokens.includes(presented)) return "Invalid token";
  return null;
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function handle(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const url = new URL(req.url);
  const maxJobs = parsePositiveInt(url.searchParams.get("maxJobs"), DEFAULT_MAX_JOBS, 10_000);
  const maxMs = parsePositiveInt(url.searchParams.get("maxMs"), DEFAULT_MAX_MS, 50_000);

  const timing = new ServerTiming();
  const requestStartedAt = timing.start();

  try {
    const drainStartedAt = timing.start();
    const drain = await drainArenaShownJobs({ maxJobs, maxMs });
    timing.end("drain", drainStartedAt);

    const statusStartedAt = timing.start();
    const pending = await getArenaShownJobStatus();
    timing.end("pending", statusStartedAt);
    timing.end("total", requestStartedAt);

    const headers = new Headers({ "Cache-Control": "no-store" });
    timing.apply(headers);
    return NextResponse.json(
      {
        ok: true,
        drain,
        pending,
      },
      { headers },
    );
  } catch (error) {
    timing.end("total", requestStartedAt);
    const headers = new Headers({ "Cache-Control": "no-store" });
    timing.apply(headers);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Shown job drain failed",
      },
      { status: 500, headers },
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
