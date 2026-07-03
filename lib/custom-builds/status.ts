import { prisma } from "@/lib/prisma";
import { serializeCustomBuildStatus } from "@/lib/custom-builds/api";

export async function getCustomBuildStatusPayload(publicId: string) {
  const customBuild = await prisma.customBuild.findUnique({
    where: { publicId },
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
      jobs: {
        orderBy: { createdAt: "asc" },
        select: {
          type: true,
          status: true,
          payload: true,
        },
      },
    },
  });

  if (!customBuild) return null;
  return serializeCustomBuildStatus({
    customBuild,
    artifacts: customBuild.artifacts,
    exportJobs: customBuild.jobs,
  });
}
