import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  estimateArenaBuildBytes,
  getArenaArtifactMinBytes,
} from "@/lib/arena/buildDeliveryPolicy";
import { getArenaBuildStreamArtifactRef } from "@/lib/arena/buildStream";
import { ServerTiming } from "@/lib/serverTiming";

export const runtime = "nodejs";

function requireAdmin(req: Request): string | null {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return "Missing ADMIN_TOKEN on server";

  const auth = req.headers.get("authorization");
  if (!auth) return "Missing Authorization header (expected: Authorization: Bearer <ADMIN_TOKEN>)";

  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "Invalid Authorization header (expected: Authorization: Bearer <ADMIN_TOKEN>)";

  const presented = match[1]?.trim();
  if (!presented) return "Empty Bearer token";
  if (presented !== token.trim()) return "Invalid token";
  return null;
}

function getDbInfo() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      database: u.pathname.replace(/^\//, "") || "unknown",
      pgbouncer: u.searchParams.get("pgbouncer") === "true",
      connectionLimit: u.searchParams.get("connection_limit"),
      poolTimeout: u.searchParams.get("pool_timeout"),
    };
  } catch {
    return {
      host: "unknown",
      port: "unknown",
      database: "unknown",
      pgbouncer: false,
      connectionLimit: null,
      poolTimeout: null,
    };
  }
}

async function getArenaArtifactCoverage() {
  const builds = await prisma.build.findMany({
    select: {
      id: true,
      blockCount: true,
      voxelByteSize: true,
      voxelCompressedByteSize: true,
      voxelSha256: true,
    },
  });

  const eligibleBuilds = builds
    .map((build) => {
      const checksum = build.voxelSha256?.trim() || null;
      const estimatedBytes = estimateArenaBuildBytes({
        blockCount: build.blockCount,
        voxelByteSize: build.voxelByteSize,
        voxelCompressedByteSize: build.voxelCompressedByteSize,
      });
      if (!checksum || estimatedBytes == null || estimatedBytes < getArenaArtifactMinBytes()) {
        return null;
      }

      const full = getArenaBuildStreamArtifactRef(build.id, "full", checksum);
      const preview = getArenaBuildStreamArtifactRef(build.id, "preview", checksum);
      if (!full || !preview) return null;

      return {
        buildId: build.id,
        bucket: full.bucket,
        fullPath: full.path,
        previewPath: preview.path,
      };
    })
    .filter(
      (
        build,
      ): build is {
        buildId: string;
        bucket: string;
        fullPath: string;
        previewPath: string;
      } => build != null,
    );

  if (eligibleBuilds.length === 0) {
    return {
      eligibleBuilds: 0,
      buildsWithBothVariants: 0,
      buildsMissingVariants: 0,
      artifactObjectsPresent: 0,
      thresholdBytes: getArenaArtifactMinBytes(),
      error: null,
    };
  }

  try {
    const pathsByBucket = new Map<string, string[]>();
    for (const build of eligibleBuilds) {
      const bucketPaths = pathsByBucket.get(build.bucket) ?? [];
      bucketPaths.push(build.fullPath, build.previewPath);
      pathsByBucket.set(build.bucket, bucketPaths);
    }

    const existingPaths = new Set<string>();
    for (const [bucket, paths] of pathsByBucket.entries()) {
      const uniquePaths = Array.from(new Set(paths));
      const rows = await prisma.$queryRaw<{ name: string }[]>(
        Prisma.sql`
          SELECT name
          FROM storage.objects
          WHERE bucket_id = ${bucket}
            AND name IN (${Prisma.join(uniquePaths)})
        `,
      );
      for (const row of rows) {
        if (row.name) existingPaths.add(row.name);
      }
    }

    const buildsWithBothVariants = eligibleBuilds.reduce((count, build) => {
      return count +
        (existingPaths.has(build.fullPath) && existingPaths.has(build.previewPath) ? 1 : 0);
    }, 0);

    return {
      eligibleBuilds: eligibleBuilds.length,
      buildsWithBothVariants,
      buildsMissingVariants: eligibleBuilds.length - buildsWithBothVariants,
      artifactObjectsPresent: existingPaths.size,
      thresholdBytes: getArenaArtifactMinBytes(),
      error: null,
    };
  } catch (error) {
    return {
      eligibleBuilds: eligibleBuilds.length,
      buildsWithBothVariants: null,
      buildsMissingVariants: null,
      artifactObjectsPresent: null,
      thresholdBytes: getArenaArtifactMinBytes(),
      error: error instanceof Error ? error.message : "artifact status lookup failed",
    };
  }
}

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  try {
    const timing = new ServerTiming();
    const requestStartedAt = timing.start();
    const artifactStartedAt = timing.start();
    const [
      promptTotal,
      promptActive,
      modelTotal,
      modelEnabled,
      buildTotal,
      matchupTotal,
      voteTotal,
      artifactCoverage,
    ] = await Promise.all([
      prisma.prompt.count(),
      prisma.prompt.count({ where: { active: true } }),
      prisma.model.count(),
      prisma.model.count({ where: { enabled: true, isBaseline: false } }),
      prisma.build.count(),
      prisma.matchup.count(),
      prisma.vote.count(),
      getArenaArtifactCoverage(),
    ]);
    timing.end("artifact_status", artifactStartedAt);
    timing.end("total", requestStartedAt);

    const headers = new Headers({ "Cache-Control": "no-store" });
    timing.apply(headers);

    return NextResponse.json(
      {
        ok: true,
        db: getDbInfo(),
        counts: {
          prompts: { total: promptTotal, active: promptActive },
          models: { total: modelTotal, enabled: modelEnabled },
          builds: { total: buildTotal },
          matchups: { total: matchupTotal },
          votes: { total: voteTotal },
        },
        artifacts: artifactCoverage,
      },
      { headers }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status query failed";
    return NextResponse.json({ error: message, db: getDbInfo() }, { status: 500 });
  }
}
