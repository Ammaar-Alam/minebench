import { NextResponse } from "next/server";
import type { ArenaBuildVariant } from "@/lib/arena/types";
import { pickBuildVariant, prepareArenaBuild } from "@/lib/arena/buildArtifacts";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function parseVariant(value: string | null): ArenaBuildVariant {
  return value === "preview" ? "preview" : "full";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ buildId: string }> },
) {
  const { buildId } = await params;
  const url = new URL(request.url);
  const variant = parseVariant(url.searchParams.get("variant"));

  const build = await prisma.build.findUnique({
    where: { id: buildId },
    select: {
      id: true,
      gridSize: true,
      palette: true,
      blockCount: true,
      voxelByteSize: true,
      voxelCompressedByteSize: true,
      voxelSha256: true,
      voxelData: true,
      voxelStorageBucket: true,
      voxelStoragePath: true,
      voxelStorageEncoding: true,
    },
  });

  if (!build) {
    return NextResponse.json({ error: "Build not found" }, { status: 404 });
  }

  let prepared: Awaited<ReturnType<typeof prepareArenaBuild>>;
  try {
    prepared = await prepareArenaBuild(build);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load build payload";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const voxelBuild = pickBuildVariant(prepared, variant);

  return NextResponse.json(
    {
      buildId,
      variant,
      checksum: prepared.checksum,
      serverValidated: true,
      buildLoadHints: prepared.hints,
      voxelBuild,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
      },
    },
  );
}
