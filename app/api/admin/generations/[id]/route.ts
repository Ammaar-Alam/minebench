import { getAuthenticatedUserId } from "@/lib/auth/request";
import { createCustomBuildArtifactSignedUrl, downloadCustomBuildArtifactBytes } from "@/lib/custom-builds/storage";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { GenerationServiceError, getAdminGenerationArtifact } from "@/lib/generations/service";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const adminId = await getAuthenticatedUserId(request);
  if (!adminId) return apiJson({ error: { code: "authentication_required", message: "Sign in to view this generation." } }, 401);
  const { id } = await context.params;
  const kind = new URL(request.url).searchParams.get("artifact");
  const kinds = kind === "preview" ? (["preview_mbv4"] as const)
    : kind === "thumbnail" ? (["preview_svg"] as const)
      : kind === "viewer" ? (["viewer_mbf1", "viewer_mbv4"] as const)
        : kind === "download" ? (["build_json"] as const)
          : null;
  if (!kinds) return apiJson({ error: { code: "not_found", message: "Artifact not found." } }, 404);
  try {
    const artifact = await getAdminGenerationArtifact(adminId, id, [...kinds]);
    if (!artifact) throw new GenerationServiceError("not_found", "Artifact not found.");
    const downloadFileName = kind === "download" ? `${id}.json` : undefined;
    const signedUrl = await createCustomBuildArtifactSignedUrl({ ...artifact, downloadFileName });
    if (signedUrl.startsWith("file:")) {
      const bytes = await downloadCustomBuildArtifactBytes(artifact);
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": artifact.contentType,
          ...(artifact.encoding === "gzip" ? { "Content-Encoding": "gzip" } : {}),
          ...(downloadFileName ? { "Content-Disposition": `attachment; filename="${downloadFileName}"` } : {}),
        },
      });
    }
    return new Response(null, { status: 307, headers: { Location: signedUrl, "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiServiceError(error);
  }
}
