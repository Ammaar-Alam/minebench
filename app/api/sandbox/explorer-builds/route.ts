import { NextResponse } from "next/server";
import { arenaCohortBuildWhere } from "@/lib/arena/eligibility";
import {
  databaseUnavailableBody,
  databaseUnavailableHeaders,
  getErrorMessage,
  isDatabaseUnavailableError,
} from "@/lib/db/errors";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  try {
    const builds = await prisma.build.findMany({
      where: arenaCohortBuildWhere(),
      orderBy: [
        { model: { displayName: "asc" } },
        { prompt: { text: "asc" } },
      ],
      select: {
        id: true,
        blockCount: true,
        model: { select: { displayName: true } },
        prompt: { select: { text: true } },
      },
    });

    return NextResponse.json(
      {
        builds: builds.map((build) => ({
          id: build.id,
          model: build.model.displayName,
          prompt: build.prompt.text,
          blockCount: build.blockCount,
        })),
      },
      {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
        },
      },
    );
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      console.warn(
        "explorer build catalog database unavailable",
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
