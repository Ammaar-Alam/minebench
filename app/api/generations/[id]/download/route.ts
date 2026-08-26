import { getAuthenticatedUserId } from "@/lib/auth/account";
import { downloadCustomBuildArtifactBytes, createCustomBuildArtifactSignedUrl } from "@/lib/custom-builds/storage";
import { apiJson, apiServiceError } from "@/lib/gallery/api";
import { GenerationServiceError, getOwnedGenerationArtifact } from "@/lib/generations/service";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await getAuthenticatedUserId(request.headers.get("cookie"));
  if (!ownerId) return apiJson({ error: { code: "authentication_required", message: "Sign in to download this generation." } }, 401);
  const id = (await context.params).id;
  try {
    const artifact = await getOwnedGenerationArtifact(ownerId, id, ["build_json"]);
    if (!artifact) throw new GenerationServiceError("not_found", "Saved generation not found.");
    const signedUrl = await createCustomBuildArtifactSignedUrl({
      bucket: artifact.bucket,
      path: artifact.path,
      downloadFileName: `${id}.json`,
    });
    if (signedUrl.startsWith("file:")) {
      const bytes = await downloadCustomBuildArtifactBytes(artifact);
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "application/json",
          "Content-Encoding": artifact.encoding === "gzip" ? "gzip" : "identity",
          "Content-Disposition": `attachment; filename="${id}.json"`,
        },
      });
    }
    return Response.redirect(signedUrl, 307);
  } catch (error) {
    return apiServiceError(error);
  }
}
