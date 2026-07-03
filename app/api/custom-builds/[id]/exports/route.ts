import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  customBuildError,
  customBuildNoStoreHeaders,
  customBuildsEnabled,
  serializeCustomBuildStatus,
} from "@/lib/custom-builds/api";
import { appendCustomBuildEvent } from "@/lib/custom-builds/events";
import { isCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { getCustomBuildJobMaxAttempts } from "@/lib/custom-builds/jobs";
import { CUSTOM_BUILD_EXPORT_FORMATS } from "@/lib/custom-builds/types";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const exportSchema = z.object({
  formats: z.array(z.enum(CUSTOM_BUILD_EXPORT_FORMATS)).min(1).max(3),
}).strict();

function exportFormatFromPayload(payload: Prisma.JsonValue | null): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const format = (payload as { format?: unknown }).format;
  return typeof format === "string" ? format : null;
}

function exportSourceBuildShaFromPayload(payload: Prisma.JsonValue | null): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const sourceBuildSha256 = (payload as { sourceBuildSha256?: unknown }).sourceBuildSha256;
  return typeof sourceBuildSha256 === "string" ? sourceBuildSha256 : null;
}

function dayKey(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!customBuildsEnabled()) {
    return customBuildError("custom_builds_disabled", "Custom builds are not enabled.", 503);
  }

  const { id } = await params;
  if (!isCustomBuildPublicId(id)) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  const parsed = exportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return customBuildError("invalid_request", parsed.error.message, 400);
  }

  const customBuild = await prisma.customBuild.findUnique({
    where: { publicId: id },
    include: {
      artifacts: true,
      jobs: true,
    },
  });
  if (!customBuild) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  if (customBuild.status !== "succeeded" || !customBuild.buildSha256) {
    return customBuildError("job_not_ready", "Build generation has not finished yet.", 409);
  }

  const formats = Array.from(new Set(parsed.data.formats));
  let queuedCount = 0;
  const queuedFormats: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "CustomBuild"
      WHERE id = ${customBuild.id}
      FOR UPDATE
    `;
    for (const format of formats) {
      const existingArtifact = await tx.customBuildArtifact.findFirst({
        where: {
          customBuildId: customBuild.id,
          kind: format,
          sourceBuildSha256: customBuild.buildSha256,
        },
        select: { id: true },
      });
      if (existingArtifact) continue;
      const activeExportJobs = await tx.customBuildJob.findMany({
        where: {
          customBuildId: customBuild.id,
          type: "export",
          status: { in: ["queued", "running"] },
        },
        select: { payload: true },
      });
      const existingJob = activeExportJobs.find(
        (job) =>
          exportFormatFromPayload(job.payload) === format &&
          exportSourceBuildShaFromPayload(job.payload) === customBuild.buildSha256,
      );
      if (existingJob) continue;
      await tx.customBuildJob.create({
        data: {
          customBuildId: customBuild.id,
          type: "export",
          status: "queued",
          maxAttempts: getCustomBuildJobMaxAttempts(),
          payload: { format, sourceBuildSha256: customBuild.buildSha256 },
        },
      });
      queuedCount += 1;
      queuedFormats.push(format);
    }
    if (queuedCount > 0) {
      await tx.customBuildStatsDaily.upsert({
        where: { day: dayKey() },
        create: { day: dayKey(), exportsRequested: queuedCount },
        update: { exportsRequested: { increment: queuedCount } },
      });
    }
  });

  for (const format of queuedFormats) {
    await appendCustomBuildEvent(customBuild.id, "export_queued", { format });
  }

  const refreshed = await prisma.customBuild.findUniqueOrThrow({
    where: { id: customBuild.id },
    include: {
      artifacts: {
        orderBy: { createdAt: "asc" },
        select: {
          kind: true,
          format: true,
          contentType: true,
          byteSize: true,
          compressedByteSize: true,
          sha256: true,
          sourceBuildSha256: true,
        },
      },
      jobs: { orderBy: { createdAt: "asc" }, select: { type: true, status: true, payload: true } },
    },
  });

  const status = serializeCustomBuildStatus({
    customBuild: refreshed,
    artifacts: refreshed.artifacts,
    exportJobs: refreshed.jobs,
  });

  return Response.json(
    {
      id,
      exports: status.exports,
      eventsUrl: `/api/custom-builds/${id}/events`,
    },
    {
      status: 202,
      headers: customBuildNoStoreHeaders(),
    },
  );
}
