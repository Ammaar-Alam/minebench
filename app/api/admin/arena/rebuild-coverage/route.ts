import { NextResponse } from "next/server";
import { rebuildArenaCoverageTables } from "@/lib/arena/coverage";
import { ServerTiming } from "@/lib/serverTiming";

export const runtime = "nodejs";

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

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  const timing = new ServerTiming();
  const requestStartedAt = timing.start();

  try {
    const rebuildStartedAt = timing.start();
    const summary = await rebuildArenaCoverageTables();
    timing.end("rebuild", rebuildStartedAt);
    timing.end("total", requestStartedAt);

    const headers = new Headers({ "Cache-Control": "no-store" });
    timing.apply(headers);

    return NextResponse.json(
      {
        ok: true,
        summary,
      },
      { headers },
    );
  } catch (error) {
    timing.end("total", requestStartedAt);
    const headers = new Headers({ "Cache-Control": "no-store" });
    timing.apply(headers);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Coverage rebuild failed",
      },
      { status: 500, headers },
    );
  }
}
