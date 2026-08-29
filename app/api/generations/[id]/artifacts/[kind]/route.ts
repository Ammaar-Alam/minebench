import { getAuthenticatedUserId } from "@/lib/auth/request";
import { createCustomBuildArtifactSignedUrl, downloadCustomBuildArtifactBytes } from "@/lib/custom-builds/storage";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { GenerationServiceError, getOwnedGenerationArtifact } from "@/lib/generations/service";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; kind: string }> }) {
  const ownerId = await getAuthenticatedUserId(request);
  if (!ownerId) return apiJson({ error: { code: "authentication_required", message: "Sign in to view this generation." } }, 401);
  const { id, kind } = await context.params;
  const kinds = kind === "preview"
    ? (["preview_mbv4"] as const)
    : kind === "thumbnail"
      ? (["preview_svg"] as const)
    : kind === "viewer"
      ? (["viewer_mbf1", "viewer_mbv4"] as const)
      : null;
  if (!kinds) return apiJson({ error: { code: "not_found", message: "Artifact not found." } }, 404);
  try {
    const artifact = await getOwnedGenerationArtifact(ownerId, id, [...kinds]);
    if (!artifact) throw new GenerationServiceError("not_found", "Artifact not found.");
    const signedUrl = await createCustomBuildArtifactSignedUrl(artifact);
    if (signedUrl.startsWith("file:")) {
      const bytes = await downloadCustomBuildArtifactBytes(artifact);
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": artifact.contentType,
          ...(artifact.encoding === "gzip" ? { "Content-Encoding": "gzip" } : {}),
        },
      });
    }
    return Response.redirect(signedUrl, 307);
  } catch (error) {
    return apiServiceError(error);
  }
}
