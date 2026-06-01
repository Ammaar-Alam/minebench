import { gzipSync } from "fflate";
import type { CustomBuildJob, Prisma } from "@prisma/client";
import { getPalette } from "@/lib/blocks/palettes";
import { decodeGzipText, sha256Hex, uploadAndRecordCustomBuildArtifact } from "@/lib/custom-builds/artifacts";
import { appendCustomBuildEvent } from "@/lib/custom-builds/events";
import { downloadCustomBuildArtifactBytes } from "@/lib/custom-builds/storage";
import { CUSTOM_BUILD_EXPORT_FORMATS, type CustomBuildExportFormat } from "@/lib/custom-builds/types";
import { prisma } from "@/lib/prisma";
import { exportVoxelBuild } from "@/lib/voxel/export";
import { parseVoxelBuildSpec } from "@/lib/voxel/validate";

function parseExportFormat(payload: Prisma.JsonValue | null): CustomBuildExportFormat {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Export job payload is missing a format");
  }
  const format = (payload as { format?: unknown }).format;
  if (CUSTOM_BUILD_EXPORT_FORMATS.includes(format as CustomBuildExportFormat)) {
    return format as CustomBuildExportFormat;
  }
  throw new Error("Export job payload has an unsupported format");
}

export async function runCustomBuildExportJob(job: CustomBuildJob): Promise<void> {
  const format = parseExportFormat(job.payload);
  const customBuild = await prisma.customBuild.findUnique({
    where: { id: job.customBuildId },
  });
  if (!customBuild) throw new Error("Custom build not found");
  if (customBuild.status !== "succeeded" || !customBuild.buildSha256) {
    throw new Error("Custom build is not ready for export");
  }

  const existing = await prisma.customBuildArtifact.findFirst({
    where: {
      customBuildId: customBuild.id,
      kind: format,
      sourceBuildSha256: customBuild.buildSha256,
    },
  });
  if (existing) {
    await appendCustomBuildEvent(customBuild.id, "export_complete", { format, reused: true });
    return;
  }

  await appendCustomBuildEvent(customBuild.id, "export_started", { format });

  const buildArtifact = await prisma.customBuildArtifact.findFirst({
    where: {
      customBuildId: customBuild.id,
      kind: "build_json",
      sourceBuildSha256: customBuild.buildSha256,
    },
  });
  if (!buildArtifact) {
    throw new Error("Custom build JSON artifact is missing");
  }

  const bytes = await downloadCustomBuildArtifactBytes({
    bucket: buildArtifact.bucket,
    path: buildArtifact.path,
  });
  const parsed = JSON.parse(decodeGzipText(bytes)) as unknown;
  const build = parseVoxelBuildSpec(parsed);
  if (!build.ok) {
    throw new Error(`Stored custom build JSON is invalid: ${build.error}`);
  }

  const palette = customBuild.palette === "advanced" ? "advanced" : "simple";
  const artifact = exportVoxelBuild(build.value, getPalette(palette), format);
  const exportBytes = format === "schem" ? gzipSync(artifact.bytes, { mtime: 0 }) : artifact.bytes;
  const exportSha = sha256Hex(exportBytes);

  await uploadAndRecordCustomBuildArtifact({
    customBuildId: customBuild.id,
    publicId: customBuild.publicId,
    kind: format,
    bytes: exportBytes,
    sha256: exportSha,
    sourceBuildSha256: customBuild.buildSha256,
    exportStats: artifact.stats as Prisma.InputJsonValue,
  });
  await appendCustomBuildEvent(customBuild.id, "export_complete", { format });
  await prisma.customBuildStatsDaily.upsert({
    where: { day: new Date(new Date().toISOString().slice(0, 10)) },
    create: { day: new Date(new Date().toISOString().slice(0, 10)), exportsSucceeded: 1 },
    update: { exportsSucceeded: { increment: 1 } },
  });
}
