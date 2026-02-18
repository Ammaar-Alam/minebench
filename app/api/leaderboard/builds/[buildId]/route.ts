import { NextResponse } from "next/server";
import { maxBlocksForGrid } from "@/lib/ai/limits";
import { getPalette } from "@/lib/blocks/palettes";
import { prisma } from "@/lib/prisma";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";

export const runtime = "nodejs";

function normalizeGridSize(value: number): 64 | 256 | 512 {
  if (value === 64 || value === 256 || value === 512) return value;
  return 256;
}

function normalizePalette(value: string): "simple" | "advanced" {
  return value === "advanced" ? "advanced" : "simple";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ buildId: string }> },
) {
  const { buildId } = await params;

  const build = await prisma.build.findUnique({
    where: { id: buildId },
    select: {
      id: true,
      voxelData: true,
      gridSize: true,
      palette: true,
      mode: true,
      blockCount: true,
    },
  });

  if (!build) {
    return NextResponse.json({ error: "Build not found" }, { status: 404 });
  }

  const gridSize = normalizeGridSize(build.gridSize);
  const palette = normalizePalette(build.palette);

  const validated = validateVoxelBuild(build.voxelData, {
    gridSize,
    palette: getPalette(palette),
    maxBlocks: maxBlocksForGrid(gridSize),
  });

  let voxelBuild = validated.ok ? validated.value.build : null;
  if (!voxelBuild) {
    const parsed = parseVoxelBuildSpec(build.voxelData);
    if (!parsed.ok) {
      return NextResponse.json({ error: "Build payload is invalid" }, { status: 422 });
    }
    voxelBuild = parsed.value;
  }

  return NextResponse.json(
    {
      buildId: build.id,
      voxelBuild,
      gridSize,
      palette,
      mode: build.mode,
      blockCount: validated.ok ? validated.value.build.blocks.length : build.blockCount,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
      },
    },
  );
}
