import { NextResponse } from "next/server";
import { maxBlocksForGrid } from "@/lib/ai/limits";
import { getPalette } from "@/lib/blocks/palettes";
import { prisma } from "@/lib/prisma";
import { resolveBuildPayload } from "@/lib/storage/buildPayload";
import { getLabIdentity } from "@/lib/stealth/auth";
import { parseVoxelBuildSpec, validateVoxelBuild } from "@/lib/voxel/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeGridSize(value: number): 64 | 256 | 512 {
  if (value === 64 || value === 256 || value === 512) return value;
  return 256;
}

function normalizePalette(value: string): "simple" | "advanced" {
  return value === "advanced" ? "advanced" : "simple";
}

function privateHeaders(): HeadersInit {
  return {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function diagnostics(result: {
  status: string;
  attempts: number;
  generationTimeMs: number;
  requestConfiguration: string | null;
  error: string | null;
  updatedAt: Date;
}) {
  return {
    status: result.status,
    attempts: result.attempts,
    generationTimeMs: result.generationTimeMs,
    requestConfiguration: result.requestConfiguration,
    error: result.status === "FAILED" && result.error ? "Generation failed" : null,
    updatedAt: result.updatedAt.toISOString(),
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgSlug: string; resultId: string }> },
) {
  const { orgSlug, resultId } = await params;
  const identity = await getLabIdentity().catch(() => null);
  if (!identity) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401, headers: privateHeaders() },
    );
  }
  const organization = identity.memberships.find(
    (membership) => membership.organization.slug === orgSlug,
  )?.organization;
  if (!organization && !identity.user.isMineBenchAdmin) {
    return NextResponse.json(
      { error: "Build not found" },
      { status: 404, headers: privateHeaders() },
    );
  }

  const result = await prisma.stealthGenerationResult.findUnique({
    where: { id: resultId },
    select: {
      id: true,
      status: true,
      attempts: true,
      generationTimeMs: true,
      requestConfiguration: true,
      error: true,
      updatedAt: true,
      prompt: { select: { text: true } },
      run: {
        select: {
          variant: {
            select: {
              codename: true,
              source: true,
              experiment: {
                select: { organizationId: true },
              },
            },
          },
        },
      },
      build: {
        select: {
          voxelData: true,
          voxelStorageBucket: true,
          voxelStoragePath: true,
          voxelStorageEncoding: true,
          gridSize: true,
          palette: true,
          mode: true,
          blockCount: true,
        },
      },
    },
  });

  if (
    !result ||
    result.run.variant.experiment.organizationId !== organization?.id &&
    !identity.user.isMineBenchAdmin
  ) {
    return NextResponse.json(
      { error: "Build not found" },
      { status: 404, headers: privateHeaders() },
    );
  }

  if (!result.build) {
    return NextResponse.json(
      { error: "Build is not ready", diagnostics: diagnostics(result) },
      { status: 409, headers: privateHeaders() },
    );
  }

  const gridSize = normalizeGridSize(result.build.gridSize);
  const palette = normalizePalette(result.build.palette);
  let payload: unknown;
  try {
    payload = await resolveBuildPayload(result.build, { signal: request.signal });
  } catch {
    return NextResponse.json(
      { error: "Build payload is unavailable", diagnostics: diagnostics(result) },
      { status: 422, headers: privateHeaders() },
    );
  }

  const validated = validateVoxelBuild(payload, {
    gridSize,
    palette: getPalette(palette),
    maxBlocks: maxBlocksForGrid(gridSize),
  });

  let voxelBuild = validated.ok ? validated.value.build : null;
  if (!voxelBuild) {
    const parsed = parseVoxelBuildSpec(payload);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: "Build payload is invalid", diagnostics: diagnostics(result) },
        { status: 422, headers: privateHeaders() },
      );
    }
    voxelBuild = parsed.value;
  }

  return NextResponse.json(
    {
      resultId: result.id,
      prompt: result.prompt.text,
      checkpoint: {
        codename: result.run.variant.codename,
        source: result.run.variant.source,
      },
      voxelBuild,
      gridSize,
      palette,
      mode: result.build.mode,
      blockCount: validated.ok ? validated.value.build.blocks.length : result.build.blockCount,
      diagnostics: diagnostics(result),
    },
    { headers: privateHeaders() },
  );
}
