import {
  artifactKindForDownloadFormat,
  customBuildError,
  customBuildNoStoreHeaders,
} from "@/lib/custom-builds/api";
import { isCustomBuildPublicId } from "@/lib/custom-builds/ids";
import { createCustomBuildArtifactSignedUrl } from "@/lib/custom-builds/storage";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function downloadFileName(publicId: string, format: string): string {
  if (format === "json") return `minebench-${publicId}.json.gz`;
  if (format === "preview-json") return `minebench-${publicId}-preview.json.gz`;
  return `minebench-${publicId}.${format}`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; format: string }> }) {
  const { id, format } = await params;
  if (!isCustomBuildPublicId(id)) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }
  const kind = artifactKindForDownloadFormat(format);
  if (!kind) {
    return customBuildError("not_found", "Custom build artifact was not found.", 404);
  }

  const customBuild = await prisma.customBuild.findUnique({
    where: { publicId: id },
    include: { artifacts: true },
  });
  if (!customBuild) {
    return customBuildError("not_found", "Custom build was not found.", 404);
  }

  const artifact = customBuild.artifacts.find((candidate) => {
    if (candidate.kind !== kind) return false;
    if (kind === "glb" || kind === "stl" || kind === "schem") {
      return candidate.sourceBuildSha256 === customBuild.buildSha256;
    }
    return true;
  });
  if (!artifact) {
    if (customBuild.status !== "succeeded") {
      return customBuildError("job_not_ready", "Build generation has not finished yet.", 409);
    }
    return Response.json(
      {
        error: {
          code: "artifact_not_ready",
          message: "The requested artifact has not finished yet.",
        },
        status: customBuild.status,
        exportsUrl: `/api/custom-builds/${id}/exports`,
      },
      {
        status: 409,
        headers: customBuildNoStoreHeaders(),
      },
    );
  }

  let signedUrl;
  try {
    signedUrl = await createCustomBuildArtifactSignedUrl({
      bucket: artifact.bucket,
      path: artifact.path,
    });
  } catch {
    return customBuildError("storage_sign_failed", "Artifact download is temporarily unavailable.", 503);
  }

  if (signedUrl.startsWith("file://")) {
    try {
      const [{ readFile }, { fileURLToPath }] = await Promise.all([
        import("node:fs/promises"),
        import("node:url"),
      ]);
      const bytes = await readFile(fileURLToPath(signedUrl));
      return new Response(new Uint8Array(bytes), {
        headers: {
          ...customBuildNoStoreHeaders(),
          "Content-Type": artifact.contentType,
          "Content-Length": String(bytes.byteLength),
          "Content-Disposition": `attachment; filename="${downloadFileName(id, format)}"`,
          "X-Custom-Build-Artifact-Sha256": artifact.sha256,
          "X-Custom-Build-Artifact-Bytes": String(artifact.compressedByteSize ?? artifact.byteSize),
        },
      });
    } catch {
      return customBuildError("artifact_not_ready", "The requested artifact is temporarily unavailable.", 503);
    }
  }

  return new Response(null, {
    status: 307,
    headers: {
      ...customBuildNoStoreHeaders(),
      Location: signedUrl,
      "Content-Disposition": `attachment; filename="${downloadFileName(id, format)}"`,
      "X-Custom-Build-Artifact-Sha256": artifact.sha256,
      "X-Custom-Build-Artifact-Bytes": String(artifact.compressedByteSize ?? artifact.byteSize),
    },
  });
}
