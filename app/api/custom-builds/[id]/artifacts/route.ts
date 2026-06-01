import {
  customBuildArtifactMatchesCurrentBuild,
  customBuildError,
  customBuildNoStoreHeaders,
  downloadFormatForArtifactKind,
} from "@/lib/custom-builds/api";
import { isCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCustomBuildPublicId(id)) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  const customBuild = await prisma.customBuild.findUnique({
    where: { publicId: id },
    include: {
      artifacts: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!customBuild) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  return Response.json(
    {
      id,
      artifacts: customBuild.artifacts
        .filter((artifact) => customBuildArtifactMatchesCurrentBuild(artifact, customBuild.buildSha256))
        .map((artifact) => ({
          kind: artifact.kind,
          format: artifact.format,
          contentType: artifact.contentType,
          byteSize: artifact.byteSize,
          compressedByteSize: artifact.compressedByteSize,
          sha256: artifact.sha256,
          downloadUrl: `/api/custom-builds/${id}/artifacts/${downloadFormatForArtifactKind(artifact.kind)}`,
        })),
    },
    { headers: customBuildNoStoreHeaders() },
  );
}
