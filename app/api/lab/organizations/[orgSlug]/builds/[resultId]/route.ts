import { NextResponse } from "next/server";
import { createArenaBuildAccessToken } from "@/lib/arena/matchupToken";
import { prisma } from "@/lib/prisma";
import { getLabIdentity } from "@/lib/stealth/auth";
import { readableStealthEvaluationWhere } from "@/lib/stealth/retention";

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
}, fallbackGenerationTimeMs?: number | null) {
  return {
    status: result.status,
    attempts: result.attempts,
    generationTimeMs: result.generationTimeMs || fallbackGenerationTimeMs || 0,
    requestConfiguration: result.requestConfiguration,
    error: result.status === "FAILED" && result.error ? "Generation failed" : null,
    updatedAt: result.updatedAt.toISOString(),
  };
}

export async function GET(
  _request: Request,
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

  const result = await prisma.stealthGenerationResult.findFirst({
    where: {
      id: resultId,
      ...(!identity.user.isMineBenchAdmin
        ? {
            run: {
              variant: {
                experiment: {
                  organizationId: organization?.id,
                  ...readableStealthEvaluationWhere(),
                },
              },
            },
          }
        : {}),
    },
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
          id: true,
          voxelSha256: true,
          gridSize: true,
          palette: true,
          mode: true,
          blockCount: true,
          voxelByteSize: true,
          generationTimeMs: true,
        },
      },
    },
  });

  if (
    !result ||
    (result.run.variant.experiment.organizationId !== organization?.id &&
      !identity.user.isMineBenchAdmin)
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
  if (!result.build.voxelSha256) {
    return NextResponse.json(
      { error: "Build payload is unavailable", diagnostics: diagnostics(result) },
      { status: 422, headers: privateHeaders() },
    );
  }

  return NextResponse.json(
    {
      resultId: result.id,
      prompt: result.prompt.text,
      checkpoint: {
        codename: result.run.variant.codename,
        source: result.run.variant.source,
      },
      streamToken: createArenaBuildAccessToken({
        buildId: result.build.id,
        checksum: result.build.voxelSha256,
      }),
      gridSize: normalizeGridSize(result.build.gridSize),
      palette: normalizePalette(result.build.palette),
      mode: result.build.mode,
      blockCount: result.build.blockCount,
      jsonBytes: result.build.voxelByteSize,
      diagnostics: diagnostics(result, result.build.generationTimeMs),
    },
    { headers: privateHeaders() },
  );
}
