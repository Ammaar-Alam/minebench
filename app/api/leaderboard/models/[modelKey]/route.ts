import { NextResponse } from "next/server";
import { getModelDetailStats } from "@/lib/arena/stats";
import {
  databaseUnavailableBody,
  databaseUnavailableHeaders,
  getErrorMessage,
  isDatabaseUnavailableError,
} from "@/lib/db/errors";
import { createModelDetailResponse } from "../modelDetailResponse";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ modelKey: string }> },
) {
  const { modelKey } = await params;

  try {
    return createModelDetailResponse(await getModelDetailStats(modelKey));
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      console.warn(
        "leaderboard model detail database unavailable",
        getErrorMessage(error, "unknown error"),
      );
      return NextResponse.json(databaseUnavailableBody(), {
        status: 503,
        headers: databaseUnavailableHeaders(),
      });
    }

    throw error;
  }
}
