import { NextResponse } from "next/server";
import { arenaCohortBuildWhere } from "@/lib/arena/eligibility";
import {
  databaseUnavailableBody,
  databaseUnavailableHeaders,
  getErrorMessage,
  isDatabaseUnavailableError,
} from "@/lib/db/errors";
import { listPublicGalleryExplorerBuilds } from "@/lib/gallery/service";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [builds, galleryBuilds] = await Promise.all([
      prisma.build.findMany({
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
      }),
      listPublicGalleryExplorerBuilds(),
    ]);

    return NextResponse.json(
      {
        builds: [
          ...galleryBuilds.map((build) => ({
            ...build,
            id: `gallery:${build.id}`,
            source: "gallery" as const,
          })),
          ...builds.map((build) => ({
            id: build.id,
            model: build.model.displayName,
            prompt: build.prompt.text,
            blockCount: build.blockCount,
            source: "benchmark" as const,
          })),
        ],
      },
      {
        headers: {
          "Cache-Control": "public, max-age=30, s-maxage=60",
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
