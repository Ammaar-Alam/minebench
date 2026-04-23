import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  estimateArenaBuildBytes,
  getArenaArtifactMinBytes,
} from "@/lib/arena/buildDeliveryPolicy";
import { getArenaBuildStreamArtifactFetchRefs } from "@/lib/arena/buildStream";
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
    where: {
      gridSize: 256,
      palette: "simple",
      mode: "precise",
      model: {
        enabled: true,
        isBaseline: false,
      },
      prompt: {
        active: true,
      },
    },
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

      const fullRefs = getArenaBuildStreamArtifactFetchRefs(build.id, "full", checksum);
      const previewRefs = getArenaBuildStreamArtifactFetchRefs(build.id, "preview", checksum);
      if (fullRefs.length === 0 || previewRefs.length === 0) return null;

      return {
        buildId: build.id,
        fullRefs,
        previewRefs,
      };
    })
    .filter(
      (
        build,
      ): build is {
        buildId: string;
        fullRefs: Array<{ bucket: string; path: string }>;
        previewRefs: Array<{ bucket: string; path: string }>;
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
      for (const ref of [...build.fullRefs, ...build.previewRefs]) {
        const bucketPaths = pathsByBucket.get(ref.bucket) ?? [];
        bucketPaths.push(ref.path);
        pathsByBucket.set(ref.bucket, bucketPaths);
      }
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
      const hasFull = build.fullRefs.some((ref) => existingPaths.has(ref.path));
      const hasPreview = build.previewRefs.some((ref) => existingPaths.has(ref.path));
      return count + (hasFull && hasPreview ? 1 : 0);
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

async function getArenaVoteJobStatus() {
  const [pendingCount, oldestPending] = await Promise.all([
    prisma.arenaVoteJob.count({ where: { processedAt: null } }),
    prisma.arenaVoteJob.findFirst({
      where: { processedAt: null },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    pendingCount,
    oldestPendingAgeMs: oldestPending
      ? Math.max(0, Date.now() - oldestPending.createdAt.getTime())
      : null,
  };
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
      voteJobs,
    ] = await Promise.all([
      prisma.prompt.count(),
      prisma.prompt.count({ where: { active: true } }),
      prisma.model.count(),
      prisma.model.count({ where: { enabled: true, isBaseline: false } }),
      prisma.build.count(),
      prisma.matchup.count(),
      prisma.vote.count(),
      getArenaArtifactCoverage(),
      getArenaVoteJobStatus(),
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
        voteJobs,
      },
      { headers }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status query failed";
    return NextResponse.json({ error: message, db: getDbInfo() }, { status: 500 });
  }
}
