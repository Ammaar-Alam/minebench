import { NextResponse } from "next/server";
import { getLeaderboardData } from "@/lib/arena/leaderboard";
import { ServerTiming } from "@/lib/serverTiming";
import {
  databaseUnavailableBody,
  databaseUnavailableHeaders,
  getErrorMessage,
  isDatabaseUnavailableError,
} from "@/lib/db/errors";

export const runtime = "nodejs";

export async function GET() {
  const timing = new ServerTiming();
  const requestStartedAt = timing.start();
  const dataStartedAt = timing.start();

  try {
    const result = await getLeaderboardData();
    timing.end("data", dataStartedAt, result.source);
    timing.end("total", requestStartedAt);

    // Edge cache absorbs bursts while Runtime Cache shares the computed result
    // across functions in the same region
    const headers = new Headers({
      "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
    });
    timing.apply(headers);
    return NextResponse.json(result.data, { headers });
  } catch (error) {
    timing.end("total", requestStartedAt);
    const headers = new Headers(databaseUnavailableHeaders());
    timing.apply(headers);

    if (isDatabaseUnavailableError(error)) {
      console.warn("leaderboard database unavailable", getErrorMessage(error, "unknown error"));
      return NextResponse.json(databaseUnavailableBody(), { status: 503, headers });
    }

    throw error;
  }
}
